import type { PeakRule } from "./settings-input.ts";

// A rule is an explicit assertion of the billing route, endpoint, plan, region and
// continuing promotion. Known reseller IDs must never inherit creator offers.
export function eligiblePeakRule(rule: PeakRule): boolean {
    const { provider, model, schedule } = rule;
    if (schedule === "or")
        return provider === "openrouter" && rule.openRouterBillingConfirmed === true;

    if (schedule === "deepseek-reseller") {
        return (
            provider === "opencode-go" && ["deepseek-v4.1-flash", "deepseek-v4-pro"].includes(model)
        );
    }

    if (["opencode-go", "openrouter", "command-code"].includes(provider)) {
        if (provider !== "command-code" || schedule !== "command") return false;
    }

    switch (schedule) {
        case "deepseek-direct":
            return [
                "deepseek-flash",
                "deepseek-v4-pro",
                "deepseek-v4-flash",
                "deepseek-v4-flash-vision-exp",
            ].includes(model);
        case "command":
            return [
                "deepseek/deepseek-v4-pro",
                "deepseek/deepseek-v4.1-flash",
                "deepseek/deepseek-v4-flash",
                "deepseek/deepseek-v4-flash-vision-exp",
                "deepseek/deepseek-v4.1-flash-fast",
            ].includes(model);
        case "glm":
            return ["glm-5.3", "glm-5.3-flash"].includes(model);
        case "qwen":
            return model === "qwen3.7-plus";
        case "ali-qwen":
            return ["qwen3.8-max", "qwen3.8-flash"].includes(model);
        case "ali-deepseek":
            return [
                "deepseek-v4-pro-0813",
                "deepseek-v4-flash-0731",
                "deepseek-v4.1-flash",
                "deepseek-v4.1-flash-1017",
            ].includes(model);
        case "mimo":
            return ["mimo-v2.6-pro", "mimo-v2.6-flash"].includes(model);
    }

    return false;
}
