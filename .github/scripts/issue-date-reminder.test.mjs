import assert from "node:assert/strict";
import test from "node:test";

import {
  addDays,
  buildDiscordMessages,
  collectReminders,
  dateInTimeZone,
  fetchOpenIssues,
  parseRepository,
  parseReminderDayOffset,
  sendDiscordMessage,
  validateDiscordWebhookUrl,
  validateIsoDate,
} from "./issue-date-reminder.mjs";

test("JST の日付と翌日を計算する", () => {
  assert.equal(dateInTimeZone(new Date("2026-08-25T15:30:00Z"), "Asia/Tokyo"), "2026-08-26");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("不正な日付とリポジトリ名を拒否する", () => {
  assert.throws(() => validateIsoDate("2026-02-29"), /valid calendar date/);
  assert.throws(() => parseRepository("owner/repo/extra"), /owner\/name/);
});

test("通知対象を今日または明日だけに制限する", () => {
  assert.equal(parseReminderDayOffset("0"), 0);
  assert.equal(parseReminderDayOffset("1"), 1);
  assert.equal(parseReminderDayOffset(undefined), 1);
  assert.throws(() => parseReminderDayOffset("2"), /must be 0/);
});

test("Discord 以外の webhook URL を拒否する", () => {
  assert.equal(
    validateDiscordWebhookUrl("https://discord.com/api/webhooks/123456/token"),
    "https://discord.com/api/webhooks/123456/token",
  );
  assert.throws(
    () => validateDiscordWebhookUrl("https://example.com/api/webhooks/123456/token"),
    /Discord webhook URL/,
  );
});

test("対象日の日付を持つ open Project の Issue だけをまとめる", () => {
  const issues = [
    {
      number: 10,
      title: "Release _candidate_",
      url: "https://github.com/example/repo/issues/10",
      projectItems: {
        totalCount: 2,
        nodes: [
          {
            project: { closed: false, title: "Life", url: "https://github.com/users/example/projects/1" },
            startDate: { date: "2026-08-26" },
            targetDate: { date: "2026-08-30" },
          },
          {
            project: { closed: false, title: "Duplicate", url: "https://github.com/users/example/projects/2" },
            startDate: { date: "2026-08-26" },
            targetDate: { date: "2026-08-26" },
          },
        ],
      },
    },
    {
      number: 11,
      title: "Closed project item",
      url: "https://github.com/example/repo/issues/11",
      projectItems: {
        totalCount: 1,
        nodes: [
          {
            project: { closed: true, title: "Old", url: "https://github.com/users/example/projects/3" },
            startDate: { date: "2026-08-26" },
            targetDate: null,
          },
        ],
      },
    },
  ];

  const reminders = collectReminders(issues, "2026-08-26");
  assert.equal(reminders.length, 1);
  assert.deepEqual(reminders[0].kinds, ["start", "target"]);
  assert.deepEqual(
    reminders[0].projects.map(({ title }) => title),
    ["Life", "Duplicate"],
  );
});

test("PROJECT_URL で対象 Project を絞り込む", () => {
  const issues = [
    {
      number: 1,
      title: "Example",
      url: "https://github.com/example/repo/issues/1",
      projectItems: {
        nodes: [
          {
            project: { closed: false, title: "A", url: "https://github.com/users/example/projects/1" },
            startDate: { date: "2026-08-26" },
            targetDate: null,
          },
          {
            project: { closed: false, title: "B", url: "https://github.com/users/example/projects/2" },
            startDate: null,
            targetDate: { date: "2026-08-26" },
          },
        ],
      },
    },
  ];

  const reminders = collectReminders(
    issues,
    "2026-08-26",
    "https://github.com/users/example/projects/2/",
  );
  assert.deepEqual(reminders[0].kinds, ["target"]);
  assert.equal(reminders[0].projects[0].title, "B");
});

test("当日通知では開始日から目標日までの期間中にある Issue も対象にする", () => {
  const issues = [
    {
      number: 2,
      title: "In progress",
      url: "https://github.com/example/repo/issues/2",
      projectItems: {
        nodes: [
          {
            project: { closed: false, title: "Life", url: "https://github.com/users/example/projects/1" },
            startDate: { date: "2026-08-25" },
            targetDate: { date: "2026-08-28" },
          },
        ],
      },
    },
  ];

  assert.equal(collectReminders(issues, "2026-08-26").length, 0);
  const reminders = collectReminders(issues, "2026-08-26", "", { includeActiveRange: true });
  assert.equal(reminders.length, 1);
  assert.deepEqual(reminders[0].kinds, ["active"]);
});

test("Discord の文字数上限で分割し、メンションは最初の投稿だけに付ける", () => {
  const reminders = Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    url: `https://github.com/example/repo/issues/${index + 1}`,
    kinds: ["target"],
    projects: [{ title: "Life", url: "https://github.com/users/example/projects/1" }],
  }));
  const messages = buildDiscordMessages(reminders, {
    mentionUserId: "123456789012345678",
    reminderDate: "2026-08-26",
    contentLimit: 240,
  });

  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 240));
  assert.match(messages[0], /^<@123456789012345678>/);
  assert.doesNotMatch(messages[1], /<@123456789012345678>/);
});

test("当日通知は未closeであることを明記する", () => {
  const messages = buildDiscordMessages(
    [
      {
        number: 1,
        title: "Today's task",
        url: "https://github.com/example/repo/issues/1",
        kinds: ["active"],
        projects: [],
      },
    ],
    {
      mentionUserId: "123456789012345678",
      reminderDate: "2026-08-26",
      dayOffset: 0,
    },
  );

  assert.match(messages[0], /今日（2026-08-26）/);
  assert.match(messages[0], /開始日・目標日、またはその期間内/);
  assert.match(messages[0], /まだcloseされていない/);
  assert.match(messages[0], /\*\*期間中\*\*/);
});

test("Discord payload は指定ユーザー以外の mention を許可しない", async () => {
  let payload;
  await sendDiscordMessage({
    webhookUrl: "https://discord.com/api/webhooks/123/token",
    mentionUserId: "123456789012345678",
    content: "<@123456789012345678> reminder",
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 204 };
    },
  });

  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    users: ["123456789012345678"],
  });
});

test("Issue API のページネーションを最後まで処理する", async () => {
  const cursors = [];
  const request = async (_query, variables) => {
    cursors.push(variables.cursor);
    const firstPage = variables.cursor === null;
    return {
      repository: {
        issues: {
          nodes: [
            {
              number: firstPage ? 1 : 2,
              projectItems: { totalCount: 0, nodes: [] },
            },
          ],
          pageInfo: {
            hasNextPage: firstPage,
            endCursor: firstPage ? "next" : "done",
          },
        },
      },
    };
  };

  const issues = await fetchOpenIssues({
    owner: "example",
    name: "repo",
    startField: "Start date",
    targetField: "Target date",
    request,
  });
  assert.deepEqual(cursors, [null, "next"]);
  assert.deepEqual(
    issues.map(({ number }) => number),
    [1, 2],
  );
});
