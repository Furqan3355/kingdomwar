import { KingdomState } from "../types";
import { CURRENT_STATE_VERSION } from "./version";

// Sequential version-chain migration. Each block below takes a state at
// version N and mutates it into a valid version N+1 state, THEN falls
// through to the next block — so a state that's several versions old gets
// walked forward one step at a time until it reaches CURRENT_STATE_VERSION.
//
// IMPORTANT: bumping CURRENT_STATE_VERSION alone does NOT backfill any new
// field on old accounts. Every field a new feature depends on must be
// explicitly set here, with a sensible default, in the matching version
// block — otherwise old accounts keep hitting that field as `undefined`
// forever, even though state.stateVersion says they're "current".
export function migrateState(state: KingdomState): KingdomState {

    // --- v0 (no stateVersion field at all) -> v1 ---
    if (state.stateVersion === undefined) {
        state.stateVersion = 1;
    }

    // --- v1 -> v2: Builder Hut feature added. Accounts created before this
    // feature have NO builder_hut entry in `buildings` at all, so
    // getBuilderHutCapacity() (buildings.ts) always computes 0 capacity for
    // them — every upgrade_building call then fails with
    // 'no_available_builder', forever, since 0 in-progress >= 0 capacity is
    // always true. Backfill one level-1 builder_hut for any account missing
    // it, same as new players get in hooks.ts.
    if (state.stateVersion === 1) {
        const hasBuilderHut = Object.keys(state.buildings).some(
            key => state.buildings[key].buildingId === 'builder_hut'
        );
        if (!hasBuilderHut) {
            // NOTE: this slot is not run through the normal placement
            // overlap check (placement.ts) — it's a direct data backfill,
            // same pattern hooks.ts uses for new-player starting buildings.
            // If a pre-existing account happens to already have something
            // placed at 2_7 (freeform placement, 0005+), this would collide
            // visually on the grid. For a real prod migration, walk the
            // grid to find a free rect instead of hardcoding one slot.
            state.buildings['builder_hut:2_7'] = {
                buildingId: 'builder_hut',
                slot: '2_7',
                level: 1,
                upgradeFinishTick: null,
            };
        }
        state.stateVersion = 2;
    }

    // --- v2 -> v3, v3 -> v4, etc. follow the same pattern: one `if` block
    // per version bump, each ending by incrementing state.stateVersion by
    // exactly 1, so a very old account walks forward through every step.

    return state;
}