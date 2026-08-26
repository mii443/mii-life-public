import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DISCORD_CONTENT_LIMIT = 1_900;

export const ISSUE_DATES_QUERY = `
  query IssueDates(
    $owner: String!
    $name: String!
    $cursor: String
    $startField: String!
    $targetField: String!
  ) {
    repository(owner: $owner, name: $name) {
      issues(
        first: 100
        after: $cursor
        states: OPEN
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          url
          projectItems(first: 100, includeArchived: false) {
            totalCount
            nodes {
              project {
                closed
                title
                url
              }
              startDate: fieldValueByName(name: $startField) {
                ... on ProjectV2ItemFieldDateValue {
                  date
                }
              }
              targetDate: fieldValueByName(name: $targetField) {
                ... on ProjectV2ItemFieldDateValue {
                  date
                }
              }
            }
          }
        }
      }
    }
  }
`;

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function parseReminderDayOffset(value) {
  const offset = Number(value ?? 1);
  if (!Number.isInteger(offset) || ![0, 1].includes(offset)) {
    throw new Error("REMINDER_DAY_OFFSET must be 0 (today) or 1 (tomorrow)");
  }
  return offset;
}

export function parseRepository(value) {
  const parts = required(value, "GITHUB_REPOSITORY").split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/name format");
  }
  return { owner: parts[0], name: parts[1] };
}

export function validateIsoDate(value, name = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be in YYYY-MM-DD format`);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid calendar date`);
  }
  return value;
}

export function dateInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(isoDate, days) {
  validateIsoDate(isoDate);
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validateMentionUserId(value) {
  const id = required(value, "MENTION_USER_ID");
  if (!/^\d{15,22}$/.test(id)) {
    throw new Error("MENTION_USER_ID must be a Discord user ID");
  }
  return id;
}

export function validateDiscordWebhookUrl(value) {
  const raw = required(value, "DISCORD_WEBHOOK_URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DISCORD_WEBHOOK_URL is not a valid URL");
  }

  const isDiscordHost =
    url.hostname === "discord.com" ||
    url.hostname.endsWith(".discord.com") ||
    url.hostname === "discordapp.com" ||
    url.hostname.endsWith(".discordapp.com");
  if (url.protocol !== "https:" || !isDiscordHost || !/^\/api\/webhooks\/\d+\//.test(url.pathname)) {
    throw new Error("DISCORD_WEBHOOK_URL must be an HTTPS Discord webhook URL");
  }
  return raw;
}

export async function graphqlRequest({ endpoint, token, query, variables, fetchImpl = fetch }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "mii-life-issue-date-reminder",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`GitHub GraphQL API returned HTTP ${response.status}`);
  }
  if (!body) {
    throw new Error("GitHub GraphQL API returned an invalid JSON response");
  }
  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL API error: ${body.errors.map(({ message }) => message).join("; ")}`);
  }
  return body.data;
}

export async function fetchOpenIssues({
  owner,
  name,
  startField,
  targetField,
  request,
  warn = console.warn,
}) {
  const issues = [];
  let cursor = null;

  do {
    const data = await request(ISSUE_DATES_QUERY, {
      owner,
      name,
      cursor,
      startField,
      targetField,
    });
    if (!data.repository) {
      throw new Error(`Repository ${owner}/${name} was not found or is not accessible`);
    }

    const connection = data.repository.issues;
    for (const issue of connection.nodes) {
      if (issue.projectItems.totalCount > issue.projectItems.nodes.length) {
        warn(
          `Issue #${issue.number} belongs to more than 100 projects; only the first 100 project items were checked.`,
        );
      }
      issues.push(issue);
    }

    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !cursor) {
      throw new Error("GitHub returned an incomplete issue pagination cursor");
    }
  } while (cursor);

  return issues;
}

function canonicalUrl(value) {
  return String(value ?? "").replace(/\/$/, "");
}

export function collectReminders(
  issues,
  reminderDate,
  projectUrl = "",
  { includeActiveRange = false } = {},
) {
  validateIsoDate(reminderDate, "reminder date");
  const projectFilter = canonicalUrl(projectUrl.trim());
  const collected = new Map();

  for (const issue of issues) {
    for (const item of issue.projectItems.nodes) {
      const project = item.project;
      if (project.closed || (projectFilter && canonicalUrl(project.url) !== projectFilter)) {
        continue;
      }

      const kinds = [];
      const startDate = item.startDate?.date;
      const targetDate = item.targetDate?.date;
      if (startDate === reminderDate) kinds.push("start");
      if (targetDate === reminderDate) kinds.push("target");
      if (
        includeActiveRange &&
        startDate &&
        targetDate &&
        startDate < reminderDate &&
        reminderDate < targetDate
      ) {
        kinds.push("active");
      }
      if (!kinds.length) continue;

      let reminder = collected.get(issue.url);
      if (!reminder) {
        reminder = {
          number: issue.number,
          title: issue.title,
          url: issue.url,
          kinds: new Set(),
          projects: new Map(),
        };
        collected.set(issue.url, reminder);
      }
      for (const kind of kinds) reminder.kinds.add(kind);
      reminder.projects.set(project.url, project.title);
    }
  }

  return [...collected.values()]
    .sort((left, right) => left.number - right.number)
    .map((reminder) => ({
      ...reminder,
      kinds: [...reminder.kinds],
      projects: [...reminder.projects].map(([url, title]) => ({ url, title })),
    }));
}

function escapeDiscordMarkdown(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
}

function reminderLine(reminder) {
  const labels = [];
  if (reminder.kinds.includes("start")) labels.push("開始日");
  if (reminder.kinds.includes("target")) labels.push("目標日");
  if (reminder.kinds.includes("active")) labels.push("期間中");

  const title = escapeDiscordMarkdown(reminder.title).slice(0, 300);
  const displayedProjects = reminder.projects.slice(0, 3);
  const projectNames = displayedProjects
    .map(({ title: projectTitle }) => escapeDiscordMarkdown(projectTitle).slice(0, 100))
    .join(", ");
  const remainingProjects = reminder.projects.length - displayedProjects.length;
  const projectText = projectNames
    ? ` （Project: ${projectNames}${remainingProjects ? `, ほか${remainingProjects}件` : ""}）`
    : "";
  return `- **${labels.join("・")}** [#${reminder.number} ${title}](${reminder.url})${projectText}`;
}

export function buildDiscordMessages(
  reminders,
  { mentionUserId, reminderDate, dayOffset = 1, contentLimit = DISCORD_CONTENT_LIMIT },
) {
  if (!reminders.length) return [];

  const isToday = dayOffset === 0;
  const firstHeader = isToday
    ? `<@${mentionUserId}> 今日（${reminderDate}）が開始日・目標日、またはその期間内で、まだcloseされていない Issue があります。`
    : `<@${mentionUserId}> 明日（${reminderDate}）が開始日または目標日の Issue があります。`;
  const continuationHeader = isToday
    ? `今日（${reminderDate}）が開始日・目標日、またはその期間内で、まだcloseされていない Issue（続き）です。`
    : `明日（${reminderDate}）が開始日または目標日の Issue（続き）です。`;
  const messages = [];
  let current = firstHeader;

  for (const reminder of reminders) {
    const line = reminderLine(reminder);
    if (`${current}\n${line}`.length > contentLimit) {
      messages.push(current);
      current = continuationHeader;
    }
    current += `\n${line}`;
  }
  messages.push(current);
  return messages;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sendDiscordMessage({ webhookUrl, mentionUserId, content, fetchImpl = fetch }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        username: "Issue date reminder",
        allowed_mentions: {
          parse: [],
          users: [mentionUserId],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) return;
    if (response.status === 429 && attempt < 3) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Math.min(Math.max(Number(body.retry_after) || 1, 0.1), 30);
      await sleep(retryAfter * 1_000);
      continue;
    }
    throw new Error(`Discord webhook returned HTTP ${response.status}`);
  }
}

async function appendStepSummary({ repository, today, reminderDate, issueCount, reminderCount, dryRun }) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const result = reminderCount
    ? `${reminderCount}件${dryRun ? "（dry-run のため未送信）" : "を Discord に通知"}`
    : "該当 Issue なし";
  const summary = [
    "## Issue date reminder",
    "",
    `- Repository: \`${repository}\``,
    `- 基準日: \`${today}\``,
    `- 通知対象日: \`${reminderDate}\``,
    `- 巡回した open Issue: ${issueCount}件`,
    `- 結果: ${result}`,
    "",
  ].join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
}

export async function main(env = process.env) {
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const { owner, name } = parseRepository(repository);
  const token = required(env.GH_PROJECTS_TOKEN, "PROJECTS_TOKEN");
  const mentionUserId = validateMentionUserId(env.MENTION_USER_ID);
  const dryRun = parseBoolean(env.DRY_RUN);
  const webhookUrl = dryRun ? env.DISCORD_WEBHOOK_URL?.trim() : validateDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL);
  const timeZone = env.REMINDER_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE;
  const today = env.TODAY_OVERRIDE?.trim()
    ? validateIsoDate(env.TODAY_OVERRIDE.trim(), "TODAY_OVERRIDE")
    : dateInTimeZone(new Date(), timeZone);
  const dayOffset = parseReminderDayOffset(env.REMINDER_DAY_OFFSET);
  const reminderDate = addDays(today, dayOffset);
  const startField = env.START_DATE_FIELD?.trim() || "Start date";
  const targetField = env.TARGET_DATE_FIELD?.trim() || "Target date";
  const endpoint = env.GITHUB_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL_URL;

  console.log(`Checking open issues in ${repository} for ${reminderDate} (${timeZone}).`);
  const issues = await fetchOpenIssues({
    owner,
    name,
    startField,
    targetField,
    request: (query, variables) =>
      graphqlRequest({ endpoint, token, query, variables }),
  });
  const reminders = collectReminders(issues, reminderDate, env.PROJECT_URL ?? "", {
    includeActiveRange: dayOffset === 0,
  });
  const messages = buildDiscordMessages(reminders, { mentionUserId, reminderDate, dayOffset });

  if (!messages.length) {
    console.log(`Checked ${issues.length} open issue(s); no reminders are due.`);
  } else if (dryRun) {
    console.log(`Dry-run: ${reminders.length} reminder(s) would be sent in ${messages.length} message(s).`);
    messages.forEach((message, index) => console.log(`\n--- Discord message ${index + 1} ---\n${message}`));
  } else {
    for (const content of messages) {
      await sendDiscordMessage({ webhookUrl, mentionUserId, content });
    }
    console.log(`Sent ${reminders.length} reminder(s) in ${messages.length} Discord message(s).`);
  }

  await appendStepSummary({
    repository,
    today,
    reminderDate,
    issueCount: issues.length,
    reminderCount: reminders.length,
    dryRun,
  });
}

const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`Issue date reminder failed: ${error.message}`);
    process.exitCode = 1;
  });
}
