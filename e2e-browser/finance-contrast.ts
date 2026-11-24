import { expect, type Locator } from '@playwright/test';

/** Composite translucent secondary backgrounds, as in the member-balance regression. */
export async function expectReadableControl(control: Locator) {
  await expect(control).toBeEnabled();
  const measured = await control.evaluate((element) => {
    const text = element.querySelector('.astryx-text') ?? element.lastElementChild ?? element;
    const foreground = getComputedStyle(text).color;
    const layers: number[][] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      layers.push(getComputedStyle(node).backgroundColor.match(/[\d.]+/g)!.map(Number));
    }
    const background = layers.reverse().reduce((under, layer) => {
      const alpha = layer[3] ?? 1;
      return layer.slice(0, 3).map((channel, i) => channel * alpha + under[i] * (1 - alpha));
    }, [255, 255, 255]);
    const luminance = (rgb: number[]) => {
      const channels = rgb.slice(0, 3).map(v => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const f = luminance(foreground.match(/[\d.]+/g)!.map(Number));
    const b = luminance(background);
    return { foreground, background, ratio: (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05) };
  });
  expect(measured.ratio, JSON.stringify(measured)).toBeGreaterThanOrEqual(4.5);
}
