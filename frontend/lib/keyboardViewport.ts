"use client";

import { useEffect } from "react";

/** The visible area must be this much shorter than the page before it counts as a keyboard. */
const KEYBOARD_MIN_PX = 120;

/**
 * Follow the on-screen keyboard. A phone lays its keyboard over the page and leaves `100dvh`
 * at full height, so a full-height page ends up half hidden. While the calling page is
 * mounted, `--visible-height` on the root element holds the height that can be seen, and
 * `data-keyboard="open"` is set while a keyboard covers part of the page.
 */
export function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;

    function clear() {
      root.style.removeProperty("--visible-height");
      delete root.dataset.keyboard;
    }

    function follow() {
      // Pinch-zoom also shrinks the visible area. Leave a zoomed page alone.
      if (Math.abs(vv!.scale - 1) > 0.01) {
        clear();
        return;
      }
      root.style.setProperty("--visible-height", `${vv!.height}px`);
      if (window.innerHeight - vv!.height > KEYBOARD_MIN_PX) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      // Safari slides the page up to show the focused box. The page now fits what is
      // visible, so put it back where it was.
      if (vv!.offsetTop > 0 || window.scrollY > 0) window.scrollTo(0, 0);
    }

    follow();
    vv.addEventListener("resize", follow);
    vv.addEventListener("scroll", follow);
    return () => {
      vv.removeEventListener("resize", follow);
      vv.removeEventListener("scroll", follow);
      clear();
    };
  }, []);
}
