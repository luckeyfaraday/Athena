// electron-builder afterPack hook: brands ATHENA.exe on Windows with the ATHENA icon and version info.
//
// The Start Menu, desktop and pinned-taskbar shortcuts show the exe's own icon, so an exe that still carries
// Electron's icon puts the Electron atom on all of them. electron-builder's own step for this
// (win.signAndEditExecutable) first downloads its signing toolkit, whose archive cannot be extracted on Windows
// without the right to create symlinks, so it stays off (electron-builder.yml) and this hook edits the resources with
// resedit, the library electron-builder itself uses for the exe's asar integrity resource. Every other resource,
// including that one, is kept as it is.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Data, NtExecutable, NtExecutableResource, Resource } = require("resedit");

exports.default = async function brandWindowsExecutable(context) {
  if (context.electronPlatformName !== "win32") return;
  const info = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, "build", "icon.ico"); // win.icon in electron-builder.yml

  const exe = NtExecutable.from(await fs.readFile(exePath));
  const resources = NtExecutableResource.from(exe);

  // The icon: replace the images of the exe's first icon group (Electron's), keeping its id and language.
  const icon = Data.IconFile.from(await fs.readFile(iconPath));
  const [group] = Resource.IconGroupEntry.fromEntries(resources.entries);
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    group ? group.id : 1,
    group ? group.lang : 1033,
    icon.icons.map((item) => item.data),
  );

  // Version info: what Explorer, Task Manager and the "Open with" list call the program.
  const [versionInfo] = Resource.VersionInfo.fromEntries(resources.entries);
  if (versionInfo) {
    const version = info.getVersionInWeirdWindowsForm();
    versionInfo.setFileVersion(version);
    versionInfo.setProductVersion(version);
    for (const language of versionInfo.getAllLanguagesForStringValues()) {
      versionInfo.setStringValues(language, {
        FileDescription: info.productName,
        ProductName: info.productName,
        CompanyName: info.companyName ?? "",
        LegalCopyright: info.copyright,
        InternalName: info.productFilename,
        OriginalFilename: `${info.productFilename}.exe`,
        FileVersion: info.version,
        ProductVersion: info.version,
      });
    }
    versionInfo.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(exe);
  await fs.writeFile(exePath, Buffer.from(exe.generate()));
  console.log(`  • branded ${path.basename(exePath)}: ATHENA icon, version ${info.version}`);
};
