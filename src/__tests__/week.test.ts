import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticatedFetch = vi.fn();
vi.mock("../auth.js", () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  getConfig: () => ({
    BCS_URL: "https://bcs.example.test",
    BCS_USER_OID: "USER1_JUser",
  }),
}));

import {
  parseWeekCells,
  getWeekTasks,
  bookWeekEffort,
  editWeekEffort,
  deleteWeekEffort,
} from "../week.js";

const CELLS = "multidaytimerecording,Content,multidaytimerecordingTaskList,Columns,days,";
const TASK = "TASK1_JTask";
// 2026-10-30 00:00 in Europe/Berlin (CET) = 2026-10-29T23:00Z
const TS = String(Date.UTC(2026, 9, 29, 23));
const CELL = `listeditoid_${TASK}.days_${TS}`;
const CLOSE = `listeditoid_${TASK}.closeReferenceState`;

function weekHtml(opts: { h?: string; m?: string; desc?: string; locked?: boolean } = {}) {
  const ro = opts.locked ? " readonly" : "";
  return `<form>
  <input type="hidden" name="transactionId" value="T1">
  <input type="hidden" name="${CELLS}closeReferenceState,!${CLOSE}" value="false">
  <input type="checkbox" name="${CELLS}closeReferenceState,${CLOSE}" value="true" checked>
  <table><tr>
    <td><a data-tt="PROJ1_JProject"><span>ADAC Test</span></a></td>
    <td><a data-tt="${TASK}"><span>Migration</span></a></td>
    <td>
      <input name="${CELLS}${CELL},${CELL}_hour" value="${opts.h ?? ""}"${ro}>
      <input name="${CELLS}${CELL},${CELL}_minute" value="${opts.m ?? ""}"${ro}>
      <textarea name="${CELLS}effortAttributesPopup,description,${CELL}.effortAttributesPopup">${opts.desc ?? ""}</textarea>
    </td>
  </tr></table>
</form>`;
}

const page = (html: string) => new Response(html, { status: 200 });

// Page GET, save POST, re-read GET.
function mockSave(before: string, after: string) {
  authenticatedFetch
    .mockResolvedValueOnce(page(before))
    .mockResolvedValueOnce(page("saved"))
    .mockResolvedValueOnce(page(after));
}

function postedBody(): URLSearchParams {
  const call = authenticatedFetch.mock.calls[1] as [string, { body: string }];
  return new URLSearchParams(call[1].body);
}

beforeEach(() => authenticatedFetch.mockReset());

describe("parseWeekCells", () => {
  it("reads time, description, task and project of the requested day", () => {
    const [cell] = parseWeekCells(weekHtml({ h: "2", m: "30", desc: "work" }), "2026-10-30");
    expect(cell).toMatchObject({
      taskOid: TASK,
      name: "Migration",
      projectOid: "PROJ1_JProject",
      hours: 2,
      minutes: 30,
      description: "work",
      locked: false,
    });
  });

  it("flags read-only cells as locked and ignores other days", () => {
    expect(parseWeekCells(weekHtml({ locked: true }), "2026-10-30")[0]?.locked).toBe(true);
    expect(parseWeekCells(weekHtml(), "2026-10-29")).toEqual([]);
  });
});

describe("week booking", () => {
  it("getWeekTasks filters by project", async () => {
    authenticatedFetch.mockImplementation(() => Promise.resolve(page(weekHtml())));
    expect(await getWeekTasks("2026-10-30", "PROJ1_JProject")).toHaveLength(1);
    expect(await getWeekTasks("2026-10-30", "OTHER_JProject")).toHaveLength(0);
  });

  it("books into an empty cell and verifies by re-reading", async () => {
    mockSave(weekHtml(), weekHtml({ h: "1", m: "30", desc: "api work" }));
    const result = await bookWeekEffort({
      date: "2026-10-30", taskOid: TASK, hours: 1, minutes: 30, description: "api work",
    });
    expect(result.success).toBe(true);
    const body = postedBody();
    expect(body.get(`${CELLS}${CELL},${CELL}_hour`)).toBe("1");
    expect(body.get(`${CELLS}${CELL},${CELL}_minute`)).toBe("30");
    expect(body.get(`${CELLS}effortAttributesPopup,description,${CELL}.effortAttributesPopup`)).toBe("api work");
    expect(body.get("multidaytimerecording,Apply")).toBe("Speichern");
    expect(body.get("transactionId")).toBe("T1");
  });

  it("never posts the close-task (beendet) flag", async () => {
    mockSave(weekHtml(), weekHtml({ h: "1", m: "00", desc: "x" }));
    await bookWeekEffort({
      date: "2026-10-30", taskOid: TASK, hours: 1, minutes: 0, description: "x",
    });
    const body = postedBody();
    expect(body.has(`${CELLS}closeReferenceState,${CLOSE}`)).toBe(false);
    expect(body.get(`${CELLS}closeReferenceState,!${CLOSE}`)).toBe("false");
  });

  it("reports failure when BCS did not apply the change", async () => {
    mockSave(weekHtml(), weekHtml());
    const result = await bookWeekEffort({
      date: "2026-10-30", taskOid: TASK, hours: 1, minutes: 0, description: "x",
    });
    expect(result.success).toBe(false);
  });

  it("refuses to book over an existing entry and on locked tasks", async () => {
    authenticatedFetch.mockResolvedValueOnce(page(weekHtml({ h: "1", m: "00" })));
    await expect(
      bookWeekEffort({ date: "2026-10-30", taskOid: TASK, hours: 1, minutes: 0, description: "x" }),
    ).rejects.toThrow(/already has 1:00h/);

    authenticatedFetch.mockResolvedValueOnce(page(weekHtml({ h: "1", m: "00", locked: true })));
    await expect(
      editWeekEffort({ date: "2026-10-30", taskOid: TASK, hours: 2 }),
    ).rejects.toThrow(/read-only/);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2); // no POST in either case
  });

  it("edit keeps omitted fields", async () => {
    mockSave(
      weekHtml({ h: "1", m: "15", desc: "old" }),
      weekHtml({ h: "3", m: "15", desc: "old" }),
    );
    const result = await editWeekEffort({ date: "2026-10-30", taskOid: TASK, hours: 3 });
    expect(result.success).toBe(true);
    expect(postedBody().get(`${CELLS}${CELL},${CELL}_minute`)).toBe("15");
  });

  it("edit rejects an empty cell", async () => {
    authenticatedFetch.mockResolvedValueOnce(page(weekHtml()));
    await expect(
      editWeekEffort({ date: "2026-10-30", taskOid: TASK, hours: 1 }),
    ).rejects.toThrow(/no booking/);
  });

  it("delete clears time and description", async () => {
    mockSave(weekHtml({ h: "2", m: "00", desc: "gone" }), weekHtml());
    const result = await deleteWeekEffort({ date: "2026-10-30", taskOid: TASK });
    expect(result.success).toBe(true);
    const body = postedBody();
    expect(body.get(`${CELLS}${CELL},${CELL}_hour`)).toBe("");
    expect(body.get(`${CELLS}effortAttributesPopup,description,${CELL}.effortAttributesPopup`)).toBe("");
  });

  it("delete on an empty cell is a no-op without POST", async () => {
    authenticatedFetch.mockResolvedValueOnce(page(weekHtml()));
    expect((await deleteWeekEffort({ date: "2026-10-30", taskOid: TASK })).success).toBe(true);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });
});
