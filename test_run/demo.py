import sys
sys.path.insert(0, "/Users/brettyoung/Desktop/quickdistill/cd_weave/real_weave/weave")

import weave
from weave.trace_server_bindings.jsonl_logging_trace_server import attach_jsonl_logger

@weave.op
def add(x: int, y: int) -> int:
    return x + y

@weave.op
def multiply(x: int, y: int) -> int:
    return x * y

client = weave.init("cdweave-test")
attach_jsonl_logger(client)

add(1, 2)
add(10, 20)
multiply(3, 4)

weave.finish()
print("Done — check runs/ folder")
