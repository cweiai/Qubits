# Toolchain image for the ContainerSandbox: node + the exact pinned versions of
# typescript / eslint / @typescript-eslint / vitest / react types used by the
# workspace check runner. Native binaries (rollup/esbuild) are installed for the
# linux target, so vitest runs inside the container.
#
# Build: bash scripts/build-toolchain-image.sh
FROM node:22

# Use a China-reachable registry mirror when the default registry is blocked.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry "$NPM_REGISTRY" && \
    mkdir -p /qubits-tools && \
    npm install --prefix /qubits-tools --no-fund --no-audit \
      typescript@5.9.3 \
      eslint@8.57.1 \
      @eslint/js@8.57.1 \
      globals@14.0.0 \
      @typescript-eslint/parser@8.67.0 \
      @typescript-eslint/eslint-plugin@8.67.0 \
      vitest@3.2.7 \
      @types/react@19.2.18 \
      @types/react-dom@19.2.4 \
      @types/node@22.20.1
