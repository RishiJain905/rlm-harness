// out[i] = a[i] + b[i] for i < n. The stub writes zeros.
GPU_KERNEL void fx_add(const float *a, const float *b, float *out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = 0.0f;
    }
}
