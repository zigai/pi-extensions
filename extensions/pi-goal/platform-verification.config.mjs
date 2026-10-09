// Platform verification configuration for pi-codex-goal.
// Reuses the portable Crabbox cross-platform testing lessons while keeping
// this package's verification gate focused on build, verify, pack, and installed pi package behavior.

export default {
  packageName: "pi-codex-goal",
  artifactRoot: ".artifacts/platform-verification",
  requiredTargets: ["macos", "ubuntu", "windows-native"],
  requiredSuites: ["platform-build", "goal-runtime-verification"],
  defaultModel: "zai/glm-5.2",
  defaultAuthEnv: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  requiredCrabbox: {
    install: "Homebrew package or PLATFORM_VERIFICATION_CRABBOX override",
    minVersion: "0.26.0",
  },
  ubuntuContainerImage: "cimg/node:24.16",
  nodeValidationMajor: 24,
  macosStaticSsh: {
    host: "localhost",
    workRoot: "/Users/$USER/crabbox/pi-codex-goal",
  },
  windowsParallels: {
    sourceVm: "pi-extension-windows-template",
    snapshot: "crabbox-ready",
    workRoot: "C:\\crabbox\\pi-codex-goal",
  },
};
