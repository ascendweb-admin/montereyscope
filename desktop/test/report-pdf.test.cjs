"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createReportPdfExporter, reportPdfFilename } = require("../lib/report-pdf.cjs");

function fixture({ canceled = false, status = "done", httpStatus = 200, failSave = false } = {}) {
  const windows = [];
  const saved = [];
  const dialogs = [];
  const requests = [];
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => (this.openHandler = handler);
      this.webContents.insertCSS = async (css) => (this.printCss = css);
      this.webContents.printToPDF = async (options) => {
        this.pdfOptions = options;
        return Buffer.from("%PDF-1.7 test");
      };
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
      this.webContents.emit("did-navigate", {}, url, httpStatus);
    }
    isDestroyed() {
      return this.destroyed === true;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const exporter = createReportPdfExporter({
    BrowserWindow: Window,
    origin: "http://127.0.0.1:1234",
    fetchReport: async (url) => {
      requests.push(url);
      return Response.json({ report: { status, title: "My report", fileUrl: "/untrusted" } });
    },
    dialog: {
      showSaveDialog: async (parent, options) => {
        dialogs.push({ parent, options });
        return { canceled, filePath: "/tmp/chosen-report" };
      },
    },
    save: async (filePath, pdf, options) => {
      if (failSave) throw new Error("Disk is full");
      saved.push({ filePath, pdf, options });
    },
  });
  return { exporter, windows, saved, dialogs, requests };
}

test("exports the registered report URL with backgrounds and destroys the isolated window", async () => {
  const { exporter, windows, saved, dialogs, requests } = fixture();
  const parent = {};
  assert.deepEqual(await exporter(parent, 7), { canceled: false });
  assert.deepEqual(requests, ["http://127.0.0.1:1234/api/ai/reports/7"]);
  assert.equal(dialogs[0].parent, parent);
  assert.equal(dialogs[0].options.defaultPath, "My report.pdf");
  assert.equal(windows[0].url, "http://127.0.0.1:1234/api/ai/reports/7/file");
  assert.equal(windows[0].options.webPreferences.javascript, false);
  assert.equal(windows[0].options.webPreferences.preload, undefined);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].pdfOptions.printBackground, true);
  assert.equal(windows[0].pdfOptions.pageSize, "A4");
  assert.match(windows[0].printCss, /details::details-content/);
  assert.equal(saved[0].filePath, "/tmp/chosen-report.pdf");
  assert.equal(saved[0].options.flag, "wx");
  assert.match(saved[0].pdf.toString(), /^%PDF-/);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(windows[0].openHandler(), { action: "deny" });
  for (const eventName of ["will-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = false;
    windows[0].webContents.emit(eventName, { preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
  }
});

test("canceling the native dialog writes nothing and creates no render window", async () => {
  const { exporter, windows, saved } = fixture({ canceled: true });
  assert.deepEqual(await exporter({}, 7), { canceled: true });
  assert.equal(windows.length, 0);
  assert.equal(saved.length, 0);
});

test("invalid ids and unfinished reports cannot open a save dialog", async () => {
  const { exporter, dialogs, requests } = fixture({ status: "running" });
  for (const id of ["7", "../file", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(exporter({}, id), /not valid/);
  }
  assert.equal(requests.length, 0);
  await assert.rejects(exporter({}, 7), /finish/);
  assert.equal(dialogs.length, 0);
});

test("a missing HTML file cannot be exported as a PDF of an error response", async () => {
  const { exporter, windows, saved } = fixture({ httpStatus: 404 });
  await assert.rejects(exporter({}, 7), /no longer available/);
  assert.equal(saved.length, 0);
  assert.equal(windows[0].destroyed, true);
});

test("write failures destroy the window and release the export lock for retry", async () => {
  const { exporter, windows } = fixture({ failSave: true });
  await assert.rejects(exporter({}, 7), /Choose another folder/);
  await assert.rejects(exporter({}, 7), /Choose another folder/);
  assert.equal(windows.length, 2);
  assert.equal(
    windows.every((window) => window.destroyed),
    true,
  );
});

test("concurrent exports cannot open competing native save dialogs", async () => {
  const { exporter, dialogs } = fixture();
  const first = exporter({}, 7);
  await assert.rejects(exporter({}, 8), /Another PDF/);
  await first;
  assert.equal(dialogs.length, 1);
});

test("report titles produce portable filenames without paths or reserved Windows names", () => {
  assert.equal(reportPdfFilename("  Research: A/B \\ C?  ", 7), "Research- A-B - C-.pdf");
  assert.equal(reportPdfFilename("Market outlook — été", 7), "Market outlook — été.pdf");
  for (const title of [null, "...", "CON", "NUL.txt", "LPT1"]) {
    assert.equal(reportPdfFilename(title, 7), "Report-7.pdf");
  }
  assert.equal(reportPdfFilename("a".repeat(200), 7).length, 84);
  assert.ok(Buffer.byteLength(reportPdfFilename("界".repeat(200), 7)) <= 255);
});
