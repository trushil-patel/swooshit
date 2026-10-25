export const MAX_FOLDER_BYTES = 250 * 1024 * 1024;
export const MAX_FOLDER_FILES = 10000;

export async function createFolderArchive(files: File[], onProgress: (percent: number) => void = () => {}) {
  if (!files.length) throw new Error("Choose a folder containing at least one file. Empty folders cannot be selected.");
  if (files.length > MAX_FOLDER_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_FOLDER_BYTES) {
    throw new Error("Choose a smaller folder: up to 250 MiB and 10,000 files. Larger folders should be zipped outside swooshit first.");
  }
  const paths = files.map((file) => file.webkitRelativePath);
  const root = paths[0]?.split("/")[0];
  const seen = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length < 2 || parts[0] !== root || parts.some((part) => !part || part === "." || part === ".." || /[\\:\u0000]/.test(part))) {
      throw new Error("Folder paths are unavailable or invalid. Use Choose folder, or send a ZIP instead.");
    }
    if (seen.has(path)) throw new Error("The folder contains duplicate paths.");
    seen.add(path);
  }
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    zip.file(paths[index], await file.arrayBuffer(), { date: new Date(file.lastModified), createFolders: true });
    onProgress(Math.round(((index + 1) / files.length) * 50));
  }
  // STORE packages without compression, avoiding unnecessary CPU work for media.
  const archive = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" }, ({ percent }) => onProgress(Math.round(50 + percent / 2)));
  return new File([archive], `${root}.zip`, { type: "application/zip" });
}
