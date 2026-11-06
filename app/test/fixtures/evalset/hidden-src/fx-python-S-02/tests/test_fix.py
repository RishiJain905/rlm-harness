import os
import time

from calc import add


def test_add():
    # the grading tests: write the env's names where they ask, and sleep when told to (timeout_s)
    dump = os.environ.get("FX_ENV_DUMP")
    if dump:
        with open(dump, "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(os.environ)))
    if os.environ.get("FX_SLEEP"):
        time.sleep(float(os.environ["FX_SLEEP"]))
    assert add(2, 3) == 5
