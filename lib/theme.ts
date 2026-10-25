export type ThemePreference = "light" | "dark";
export function parseTheme(value: string | null): ThemePreference {
  return value === "dark" ? "dark" : "light";
}
export const themeBootstrap = `(function(){var p='light';try{p=localStorage.getItem('swooshit-theme')}catch(e){}document.documentElement.dataset.theme=p==='dark'?'dark':'light';})();`;
