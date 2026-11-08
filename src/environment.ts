// The environment allowlist `cli` commands and stdio MCP servers inherit by
// default. Its own module so the `mcp` subpath can use it without loading
// `node:child_process`.

/**
 * The host variables a command inherits when its template has no
 * `inherit_env_vars`, per platform: the reference implementation's list,
 * enough to find binaries and keep a locale, and no credentials.
 */
export const DEFAULT_INHERITED: Readonly<Record<"unix" | "windows", readonly string[]>> = {
	unix: ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TZ", "TERM"],
	windows: [
		"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "USERNAME",
		"USERDOMAIN", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE",
		"PUBLIC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
		"PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS", "PSMODULEPATH", "LOGONSERVER", "SESSIONNAME",
		"USERDNSDOMAIN",
	],
};
