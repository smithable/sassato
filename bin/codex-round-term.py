import json, os, pty, select, sys
# Run the command in CODEX_ROUND_ARGV (a JSON list) in a pseudo-terminal with no reader: answer cursor-position
# queries, log the rest. The command comes from the environment so this process's own command line never looks
# like the window it runs.
pid, fd = pty.fork()
if pid == 0:
    argv = json.loads(os.environ['CODEX_ROUND_ARGV'])
    os.execvp(argv[0], argv)
log = open(sys.argv[1], 'ab')
while True:
    try:
        r, _, _ = select.select([fd], [], [], 1)
        if r:
            data = os.read(fd, 65536)
            if not data: break
            log.write(data); log.flush()
            if b'\x1b[6n' in data: os.write(fd, b'\x1b[1;1R')
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
