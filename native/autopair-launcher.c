// main executable of "Open Passwords Helper.app". macOS names the process asking for
// Automation/Accessibility after the app bundle, so the permission prompt says
// "Open Passwords" instead of "Python 3". it only execs the reader script next to it.
#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char exe[4096];
  uint32_t n = sizeof(exe);
  if (_NSGetExecutablePath(exe, &n) != 0) return 1;
  char real[4096];
  if (!realpath(exe, real)) return 1;
  char *macos = strdup(dirname(real));      /* .../Contents/MacOS */
  char *contents = strdup(dirname(macos));  /* .../Contents */
  char script[4096];
  snprintf(script, sizeof script, "%s/Resources/openpasswords-autopair.py", contents);

  char **args = calloc((size_t)argc + 3, sizeof(char *));
  args[0] = "/usr/bin/python3";
  args[1] = script;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  args[argc + 1] = NULL;
  execv(args[0], args);
  perror("execv");
  return 1;
}
