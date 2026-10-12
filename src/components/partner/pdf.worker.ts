// Web worker entry for PDF.js (used by MouViewer). Importing the worker build
// is enough: it attaches its message handler to the worker scope on load.
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
