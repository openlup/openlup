import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeViteConsumerConfig(
  consumerDir: string,
  packageName: string,
  expectedExports: number,
): void {
  const expectedDistRoot = `${join(
    realpathSync(consumerDir),
    "node_modules",
    ...packageName.split("/"),
    "dist",
  ).replaceAll("\\", "/")}/`;
  const expectedPackageRoot = expectedDistRoot.slice(0, -"dist/".length);
  writeFileSync(
    join(consumerDir, "vite.config.mjs"),
    [
      `const expectedDistRoot = ${JSON.stringify(expectedDistRoot)};`,
      `const expectedPackageRoot = ${JSON.stringify(expectedPackageRoot)};`,
      "export default {",
      "  plugins: [{",
      "    name: 'assert-core-dist-resolution',",
      "    buildEnd() {",
      "      const moduleIds = [...this.getModuleIds()].map((id) => id.replaceAll('\\\\', '/'));",
      "      const forbidden = moduleIds.filter((id) => /(?:packages\\/platform|node_modules\\/@openlup\\/platform)\\/dist\\/fulfillment\\//.test(id) || id.endsWith('/server/runtime/public-reference/m08FulfillmentBinding.ts') || id.endsWith('/server/runtime/public-reference/m08FulfillmentBinding.js') || id.endsWith('/src/pages/account/v2/orders/OrdersScreen.tsx') || id.endsWith('/src/pages/account/v2/orders/OrderTrackingStepper.tsx'));",
      "      if (forbidden.length > 0) throw new Error(`core browser consumer loaded fulfillment runtime or host UI: ${forbidden.join(', ')}`);",
      "      const coreIds = moduleIds.filter((id) => id.startsWith(expectedPackageRoot));",
      `      if (coreIds.length < ${expectedExports}) throw new Error(\`core package Vite loaded only \${coreIds.length}/${expectedExports} public export modules\`);`,
      "      const outsideDist = coreIds.filter((id) => !id.startsWith(expectedDistRoot));",
      "      if (outsideDist.length > 0) throw new Error(`core package Vite loaded modules outside installed dist: ${outsideDist.join(', ')}`);",
      "    },",
      "  }],",
      "  build: { logLevel: 'silent', target: 'es2022' },",
      "};",
      "",
    ].join("\n"),
  );
}
