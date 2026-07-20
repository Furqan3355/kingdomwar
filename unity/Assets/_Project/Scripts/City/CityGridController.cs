// Assets/_Project/Scripts/City/CityGridController.cs
using System.Collections.Generic;
using StormMmorts.Core;
using StormMmorts.Data;
using UnityEngine;

namespace StormMmorts.City
{
    /// <summary>
    /// Owns the City scene's fixed 7x7 grid (Volume 2 §1.2). This is a
    /// strategic grid with stable slot identifiers, not a freeform
    /// placement system (§1.4) — every BuildingSlotView is pre-placed in
    /// the scene/prefab and simply renders whatever the server says
    /// occupies its slot, it never decides placement itself.
    /// </summary>
    public class CityGridController : MonoBehaviour
    {
        public const int GridSize = 7;

        [Tooltip("All BuildingSlotViews in the scene, one per occupied grid position. " +
                 "Assign in the inspector or populate via GetComponentsInChildren at Awake.")]
        [SerializeField] private List<BuildingSlotView> slotViews = new List<BuildingSlotView>();

        [SerializeField] private BuildingDetailPanel detailPanel;

        private readonly Dictionary<string, BuildingSlotView> _viewsBySlot = new Dictionary<string, BuildingSlotView>();

        public static string SlotIdFor(int row, int col) => $"{row}_{col}";

        public static bool IsValidSlot(string slotId)
        {
            if (string.IsNullOrEmpty(slotId)) return false;
            var parts = slotId.Split('_');
            if (parts.Length != 2) return false;
            return int.TryParse(parts[0], out var r) && int.TryParse(parts[1], out var c)
                   && r >= 0 && r < GridSize && c >= 0 && c < GridSize;
        }

        private void Awake()
        {
            if (slotViews.Count == 0)
            {
                slotViews.AddRange(GetComponentsInChildren<BuildingSlotView>(includeInactive: true));
            }

            foreach (var view in slotViews)
            {
                if (!IsValidSlot(view.SlotId))
                {
                    Debug.LogError($"BuildingSlotView on '{view.name}' has an invalid slotId '{view.SlotId}' " +
                                    $"— must be 'row_col' within a {GridSize}x{GridSize} grid.");
                    continue;
                }
                _viewsBySlot[view.SlotId] = view;
                view.Initialize(OnSlotTapped);
            }
        }

        private void OnEnable()
        {
            // Services.Initialize() runs during Boot (Volume 1 §3.2) before the
            // City scene loads, so PlayerData is guaranteed non-null here.
            Services.PlayerData.OnStateChanged += RefreshAllSlots;
            RefreshAllSlots();
        }

        private void OnDisable()
        {
            Services.PlayerData.OnStateChanged -= RefreshAllSlots;
        }

        /// <summary>
        /// Re-renders every slot from the current authoritative KingdomState.
        /// Called on every state change (§2.2's optimistic-update policy —
        /// this fires for both the optimistic write and the reconciled
        /// server response, so slots never show stale data for longer than
        /// one frame).
        /// </summary>
        private void RefreshAllSlots()
        {
            var kingdom = Services.PlayerData.Kingdom;
            if (kingdom == null) return; // not loaded yet (pre get_full_state)

            foreach (var kvp in _viewsBySlot)
            {
                var slotId = kvp.Key;
                BuildingInstance found = null;
                // Buildings are keyed "buildingId:slot" server-side (Volume 1
                // §7.3) — the client doesn't know the buildingId in advance for
                // an empty slot, so this scans by slot rather than a direct
                // dictionary lookup. Fine at city-grid scale (dozens of slots).
                foreach (var building in kingdom.buildings.Values)
                {
                    if (building.slot == slotId)
                    {
                        found = building;
                        break;
                    }
                }
                kvp.Value.Render(found);
            }
        }

        private void OnSlotTapped(BuildingSlotView view, BuildingInstance currentInstance)
        {
            if (detailPanel == null)
            {
                Debug.LogWarning("CityGridController has no BuildingDetailPanel assigned.");
                return;
            }
            detailPanel.Open(view.SlotId, currentInstance);
        }
    }
}
