import numpy as np

import kernels


def test_compiles_and_launches():
    out = kernels.add(np.zeros(0, np.float32), np.zeros(0, np.float32))
    assert out.shape == (0,)
