import assert from "node:assert/strict";
import test from "node:test";

import { extractDeviceCode, extractLoginUrls } from "./acp-login.js";

test("extractLoginUrls finds OAuth URLs and strips terminal punctuation", () => {
  assert.deepEqual(
    extractLoginUrls("Open https://auth.example.test/device. Then visit https://auth.example.test/device"),
    ["https://auth.example.test/device"],
  );
});

test("extractDeviceCode finds labelled device codes", () => {
  assert.equal(extractDeviceCode("Your device code: ABCD-EFGH"), "ABCD-EFGH");
  assert.equal(extractDeviceCode("Confirm this code in your browser:\nBT4W-PWJY"), "BT4W-PWJY");
});
