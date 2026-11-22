import os, pty, select, sys, time
# Run argv in a pseudo-terminal with no reader: answer cursor-position queries, log the rest.
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
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
