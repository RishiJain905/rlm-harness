import numpy as np

import kernels


def test_add_several_blocks():
    rng = np.random.default_rng(0)
    a = rng.standard_normal(1000).astype(np.float32)
    b = rng.standard_normal(1000).astype(np.float32)
    np.testing.assert_allclose(kernels.add(a, b), a + b, atol=1e-6, rtol=0)
