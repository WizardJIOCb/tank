import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const baseUrl = process.env.SMOKE_URL || "http://localhost:3000";

let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
} catch {
  browser = await chromium.launch({ headless: true });
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByTestId("lobby-panel").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "Создать бой" }).click();
  await page.locator("#battleCode").waitFor({ state: "visible", timeout: 10_000 });

  const battleCode = await page.locator("#battleCode").innerText();
  assert.match(battleCode, /Код [A-F0-9]{6}/);

  const rosterRows = await page.locator(".roster-row").count();
  assert.equal(rosterRows, 1);

  const canvasStats = await page.locator("#arena").evaluate(async (canvas) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const image = new Image();
    image.src = canvas.toDataURL("image/png");
    await image.decode();

    const probe = document.createElement("canvas");
    probe.width = 80;
    probe.height = 50;
    const context = probe.getContext("2d");
    context.drawImage(image, 0, 0, probe.width, probe.height);

    const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
    let litPixels = 0;
    let variedPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      if (r + g + b > 60) litPixels += 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 8) variedPixels += 1;
    }

    return {
      width: canvas.width,
      height: canvas.height,
      litPixels,
      variedPixels
    };
  });

  assert.ok(canvasStats.width >= 1000, `unexpected canvas width: ${canvasStats.width}`);
  assert.ok(canvasStats.height >= 700, `unexpected canvas height: ${canvasStats.height}`);
  assert.ok(canvasStats.litPixels > 800, `canvas appears too dark: ${canvasStats.litPixels}`);
  assert.ok(canvasStats.variedPixels > 200, `canvas appears visually flat: ${canvasStats.variedPixels}`);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
