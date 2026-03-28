import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("wormholeToken", (m) => {
    const split = m.contract("Split", [], { libraries: {} });

    return { split };
});