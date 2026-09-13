import test from "node:test";
import assert from "node:assert/strict";
import { estimatePdfPages } from "../src/invoices.js";

test("conteo conservador de páginas PDF reconoce objetos Page", () => {
  const fakePdf = Buffer.from("%PDF-1.7\n/Type /Page\n/Type /Pages\n/Type /Page\n%%EOF", "latin1");
  assert.equal(estimatePdfPages(fakePdf), 2);
});

