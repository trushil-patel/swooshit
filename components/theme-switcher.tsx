"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { parseTheme, type ThemePreference } from "../lib/theme";

export default function ThemeSwitcher() {
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  useEffect(() => {
    // Restore browser-only preferences after hydration without changing initial HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { setPreference(parseTheme(localStorage.getItem("swooshit-theme"))); }
    catch { setPreference("light"); }
    const sync = (event: StorageEvent) => {
      if (event.key === "swooshit-theme" || event.key === null) setPreference(parseTheme(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (!preference) return;
    document.documentElement.dataset.theme = preference;
  }, [preference]);
  const dark = preference === "dark";
  return <button type="button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    title={dark ? "Switch to light theme" : "Switch to dark theme"}
    disabled={preference === null}
    className="theme-select grid h-11 w-11 shrink-0 place-items-center rounded-full border shadow-sm outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transform-none"
      onClick={() => {
        const next = dark ? "light" : "dark";
        setPreference(next);
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("swooshit-theme", next); } catch {}
      }}>
      {dark ? <Sun size={20} strokeWidth={1.8} aria-hidden="true" /> : <Moon size={20} strokeWidth={1.8} aria-hidden="true" />}
  </button>;
}
