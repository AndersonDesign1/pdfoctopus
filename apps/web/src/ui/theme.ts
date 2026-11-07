// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Light / dark theme. "system" follows the operating system; the choice is remembered in
// localStorage when available (it may not be, e.g. in private windows).

import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "pdfoctopus.theme";
export const THEMES: Theme[] = ["system", "light", "dark"];

function load(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(load);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Not remembered this time; the theme still applies.
    }
  }, [theme]);
  return [theme, setTheme];
}
