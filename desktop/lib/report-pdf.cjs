"use strict";

const { writeFile } = require("node:fs/promises");

/** A portable filename; the document title comes from the local report API. */
function reportPdfFilename(title, reportId) {
  const name = (typeof title === "string" ? title : "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80)
    .replace(/[. ]+$/g, "");
  const safe = name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  return `${safe ? name : `Report-${reportId}`}.pdf`;
}

/**
 * Only a report id crosses IPC. URLs, report titles and save locations are
 * resolved by the host; untrusted report HTML gets no preload or JavaScript.
 */
function createReportPdfExporter({ BrowserWindow, dialog, origin, fetchReport, save = writeFile }) {
  let busy = false;
  return async function exportReportPdf(parent, reportId) {
    if (!Number.isSafeInteger(reportId) || reportId <= 0) {
      throw new Error("That report reference is not valid.");
    }
    if (busy) {
      throw new Error("Another PDF is being saved. Wait for it to finish.");
    }
    busy = true;
    let window;
    try {
      const response = await fetchReport(`${origin}/api/ai/reports/${reportId}`);
      if (!response.ok) {
        throw new Error("That report could not be found.");
      }
      const { report } = await response.json();
      if (report?.status !== "done" || !report.fileUrl) {
        throw new Error("Wait for the report to finish before saving a PDF.");
      }
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        title: "Save report as PDF",
        defaultPath: reportPdfFilename(report.title, reportId),
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
        properties: ["showOverwriteConfirmation"],
      });
      if (canceled || !filePath) {
        return { canceled: true };
      }

      const reportUrl = `${origin}/api/ai/reports/${reportId}/file`;
      window = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          javascript: false,
          devTools: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-redirect", (event) => event.preventDefault());
      let statusCode = null;
      window.webContents.on("did-navigate", (_event, _url, code) => {
        statusCode = code;
      });
      await window.loadURL(reportUrl);
      if (statusCode !== 200) {
        throw new Error("The report file is no longer available. Try opening the report again.");
      }
      // Research briefs keep source archives in collapsed <details>. Include
      // their contents in print without running any JavaScript in the report.
      await window.webContents.insertCSS(
        "@media print { details::details-content { content-visibility: visible !important; } }",
        { cssOrigin: "user" },
      );
      const pdf = await window.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        displayHeaderFooter: false,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      });
      const hasPdfExtension = /\.pdf$/i.test(filePath);
      try {
        // When adding an extension, the native dialog has not confirmed an
        // overwrite of that suffixed path. Refuse to silently replace it.
        await save(hasPdfExtension ? filePath : `${filePath}.pdf`, pdf, {
          flag: hasPdfExtension ? "w" : "wx",
        });
      } catch (error) {
        const message =
          error.code === "EEXIST"
            ? "A PDF with that name already exists. Choose its full .pdf filename to replace it."
            : "Could not save the PDF to that location. Choose another folder and try again.";
        throw new Error(message, { cause: error });
      }
      return { canceled: false };
    } finally {
      if (window && !window.isDestroyed()) {
        window.destroy();
      }
      busy = false;
    }
  };
}

module.exports = { createReportPdfExporter, reportPdfFilename };
