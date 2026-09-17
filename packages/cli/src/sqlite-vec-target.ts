export const sqliteVecHost = (platform: string, arch: string) => {
  switch (platform === "win32" ? `windows-${arch}` : `${platform}-${arch}`) {
    case "linux-x64":
      return "linux-x64";
    case "linux-arm64":
      return "linux-arm64";
    case "darwin-x64":
      return "darwin-x64";
    case "darwin-arm64":
      return "darwin-arm64";
    case "windows-x64":
      return "windows-x64";
  }
};
