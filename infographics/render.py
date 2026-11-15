"""Render the 4 Persian infographic HTML files to PNG via Playwright."""
import asyncio
import os

from playwright.async_api import async_playwright

BASE = os.path.dirname(os.path.abspath(__file__))
JOBS = [
    ("1-how-it-works.html", "1-how-it-works.png"),
    ("2-install.html", "2-install.png"),
    ("3-setup-steps.html", "3-setup-steps.png"),
    ("4-notes.html", "4-notes.png"),
]


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        for src, out in JOBS:
            page = await browser.new_page(
                viewport={"width": 1180, "height": 900},
                device_scale_factor=2,
            )
            await page.goto(f"file://{BASE}/{src}", wait_until="networkidle")
            await page.wait_for_timeout(400)
            el = page.locator("#root")
            bbox = await el.bounding_box()
            if bbox:
                await page.set_viewport_size(
                    {
                        "width": max(1180, int(bbox["width"]) + 40),
                        "height": int(bbox["height"]) + 40,
                    }
                )
                await page.wait_for_timeout(200)
            await el.screenshot(path=f"{BASE}/{out}")
            size_kb = os.path.getsize(f"{BASE}/{out}") // 1024
            print(f"OK {out} ({size_kb} KB, bbox {int(bbox['width'])}x{int(bbox['height'])})")
            await page.close()
        await browser.close()


asyncio.run(main())
