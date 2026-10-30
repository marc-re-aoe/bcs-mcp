import { parse as parseHtml } from "node-html-parser";
import { authenticatedFetch, getConfig } from "./auth.js";
import { parseFormState } from "./api.js";
import { log } from "./logger.js";

// Week booking view ("Wochenbuchen"): one editable cell per task and day.
// Unlike the day view it does not depend on the user's block layout, and a
// cell is edited or cleared by posting new values (no per-row delete dialog).
const WEEK_PATH = "/bcs/mybcs/multidaytimerecording/display";
const SEL = "multidaytimerecording,Selections,effortRecordingDate";
const CELLS = "multidaytimerecording,Content,multidaytimerecordingTaskList,Columns,days,";
// shortcut: assumes the BCS server renders day columns in this timezone, upgrade if instances differ
const BCS_TIMEZONE = "Europe/Berlin";

export interface WeekCell {
  taskOid: string;
  name: string;
  projectOid?: string;
  date: string;
  hours: number;
  minutes: number;
  description: string;
  locked: boolean;
}

function hourKey(task: string, ts: string): string {
  return `${CELLS}listeditoid_${task}.days_${ts},listeditoid_${task}.days_${ts}_hour`;
}
function minuteKey(task: string, ts: string): string {
  return hourKey(task, ts).replace(/_hour$/, "_minute");
}
function descKey(task: string, ts: string): string {
  return `${CELLS}effortAttributesPopup,description,listeditoid_${task}.days_${ts}.effortAttributesPopup`;
}

function tsToDate(ts: string): string {
  return new Date(Number(ts)).toLocaleDateString("sv-SE", {
    timeZone: BCS_TIMEZONE,
  });
}

async function fetchWeekPage(date: string): Promise<string> {
  const config = getConfig();
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) throw new Error(`Invalid date: ${date}`);
  const params = new URLSearchParams({
    oid: config.BCS_USER_OID,
    [`${SEL},year`]: year,
    [`${SEL},month`]: String(parseInt(month, 10)),
    [`${SEL},day`]: String(parseInt(day, 10)),
    transactionId: `${Date.now()}-mcp`,
  });
  const res = await authenticatedFetch(
    `${config.BCS_URL}${WEEK_PATH}?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch week page: ${res.status}`);
  const html = await res.text();
  if (!html.includes("multidaytimerecording")) {
    throw new Error("Invalid page: missing multidaytimerecording form");
  }
  return html;
}

export function parseWeekCells(html: string, date: string): WeekCell[] {
  const root = parseHtml(html);
  const fields = new Map(parseFormState(html));
  const cells: WeekCell[] = [];

  for (const input of root.querySelectorAll("input[name]")) {
    const m = /listeditoid_(\w+_JTask)\.days_(\d+),.*_hour$/.exec(
      input.getAttribute("name") ?? "",
    );
    if (!m?.[1] || !m[2] || tsToDate(m[2]) !== date) continue;
    const [, task, ts] = m;

    let row = input.parentNode;
    while (row && row.tagName !== "TR") row = row.parentNode;
    const link = (suffix: string) =>
      row?.querySelector(`a[data-tt$="${suffix}"]`);
    const taskName = link("_JTask")?.text.replace(/\s+/g, " ").trim();

    cells.push({
      taskOid: task,
      name: taskName || task,
      projectOid: link("_JProject")?.getAttribute("data-tt") ?? undefined,
      date,
      hours: parseInt(fields.get(hourKey(task, ts)) ?? "", 10) || 0,
      minutes: parseInt(fields.get(minuteKey(task, ts)) ?? "", 10) || 0,
      description: fields.get(descKey(task, ts)) ?? "",
      locked: input.getAttribute("readonly") !== undefined,
    });
  }
  return cells;
}

export async function getWeekTasks(
  date: string,
  projectOid?: string,
): Promise<WeekCell[]> {
  const cells = parseWeekCells(await fetchWeekPage(date), date);
  return projectOid ? cells.filter((c) => c.projectOid === projectOid) : cells;
}

// Posts the whole week form with one cell changed, then re-reads the cell.
async function writeCell(
  date: string,
  taskOid: string,
  change: (cell: WeekCell) => { hours: number; minutes: number; description: string } | null,
): Promise<{ success: boolean; before: WeekCell; after: WeekCell }> {
  const config = getConfig();
  const html = await fetchWeekPage(date);
  const before = parseWeekCells(html, date).find((c) => c.taskOid === taskOid);
  if (!before) {
    throw new Error(
      `Task ${taskOid} is not in the week view for ${date}. Use bcs_get_tasks to list available tasks.`,
    );
  }
  if (before.locked) {
    throw new Error(
      `Task "${before.name}" is read-only in BCS for this week (it already has bookings that BCS has locked); change it in BCS.`,
    );
  }
  const next = change(before);
  if (!next) return { success: true, before, after: before };

  const ts = [...parseHtml(html).querySelectorAll("input[name]")]
    .map((i) => i.getAttribute("name") ?? "")
    .map((n) => new RegExp(`listeditoid_${taskOid}\\.days_(\\d+),.*_hour$`).exec(n)?.[1])
    .find((t) => t !== undefined && tsToDate(t) === date);
  if (!ts) throw new Error(`No day column for ${date}`);

  const body = new URLSearchParams(parseFormState(html));
  const empty = next.hours === 0 && next.minutes === 0;
  body.set(hourKey(taskOid, ts), empty ? "" : String(next.hours));
  body.set(minuteKey(taskOid, ts), empty ? "" : String(next.minutes).padStart(2, "0"));
  body.set(descKey(taskOid, ts), empty ? "" : next.description);
  body.set("multidaytimerecording,Apply", "Speichern");
  body.set("PageForm,formChangedIndicator", "true");

  const res = await authenticatedFetch(`${config.BCS_URL}${WEEK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: config.BCS_URL,
      Referer: `${config.BCS_URL}${WEEK_PATH}?oid=${config.BCS_USER_OID}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Failed to save week page: ${res.status}`);

  const after = parseWeekCells(await fetchWeekPage(date), date).find(
    (c) => c.taskOid === taskOid,
  );
  if (!after) throw new Error("Task vanished from the week view after saving");
  const success =
    after.hours === next.hours &&
    after.minutes === next.minutes &&
    after.description === (empty ? "" : next.description);
  log("api:week", "cell saved", { date, taskOid, success });
  return { success, before, after };
}

const isEmpty = (c: WeekCell): boolean => c.hours === 0 && c.minutes === 0;

export function bookWeekEffort(p: {
  date: string;
  taskOid: string;
  hours: number;
  minutes: number;
  description: string;
}) {
  return writeCell(p.date, p.taskOid, (cell) => {
    if (!isEmpty(cell)) {
      throw new Error(
        `Task "${cell.name}" already has ${cell.hours}:${String(cell.minutes).padStart(2, "0")}h on ${p.date}; the week view holds one entry per task and day. Use bcs_edit_effort to change it.`,
      );
    }
    return { hours: p.hours, minutes: p.minutes, description: p.description };
  });
}

export function editWeekEffort(p: {
  date: string;
  taskOid: string;
  hours?: number;
  minutes?: number;
  description?: string;
}) {
  return writeCell(p.date, p.taskOid, (cell) => {
    if (isEmpty(cell)) {
      throw new Error(
        `Task "${cell.name}" has no booking on ${p.date} to edit. Use bcs_book_effort.`,
      );
    }
    return {
      hours: p.hours ?? cell.hours,
      minutes: p.minutes ?? cell.minutes,
      description: p.description ?? cell.description,
    };
  });
}

export function deleteWeekEffort(p: { date: string; taskOid: string }) {
  return writeCell(p.date, p.taskOid, (cell) =>
    isEmpty(cell) ? null : { hours: 0, minutes: 0, description: "" },
  );
}
