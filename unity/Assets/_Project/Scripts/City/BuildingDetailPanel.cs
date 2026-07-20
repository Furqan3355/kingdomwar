// Assets/_Project/Scripts/City/BuildingDetailPanel.cs
using StormMmorts.Core;
using StormMmorts.Data;
using UnityEngine;
using UnityEngine.UI;

namespace StormMmorts.City
{
    /// <summary>
    /// Opens on tapping a BuildingSlotView (Volume 2 §1.1). Shows the
    /// building's current state and drives the upgrade action through
    /// PlayerDataService, which already owns the optimistic-update +
    /// server-reconcile flow (§2.4) — this panel never talks to
    /// NakamaClientService directly.
    ///
    /// KNOWN GAP (flagging rather than fabricating): this panel can show
    /// cost/timer for an upgrade only from server responses (after a request
    /// is made or a failed attempt returns an error), not as a pre-confirm
    /// preview. A true pre-confirm cost/timer preview needs the client-side
    /// ScriptableObject config bundle described in Volume 1 §9.2 — that
    /// bundle and its loader don't exist in the Unity project yet, so this
    /// panel doesn't fabricate one. Wire that up before shipping this UI.
    /// For an EMPTY slot, the caller must supply which buildingId is valid
    /// there via SetPendingBuildTarget — a build-menu that reads
    /// building_slot bindings client-side isn't in scope for this pass
    /// either.
    /// </summary>
    public class BuildingDetailPanel : MonoBehaviour
    {
        [SerializeField] private GameObject root;
        [SerializeField] private Text titleLabel;
        [SerializeField] private Text statusLabel;
        [SerializeField] private Button upgradeButton;
        [SerializeField] private Button closeButton;

        private string _slotId;
        private BuildingInstance _currentInstance;
        private string _pendingBuildBuildingId; // used only when _currentInstance is null

        private void Awake()
        {
            if (upgradeButton != null) upgradeButton.onClick.AddListener(HandleUpgradeClicked);
            if (closeButton != null) closeButton.onClick.AddListener(Close);
            Close();
        }

        public void Open(string slotId, BuildingInstance currentInstance)
        {
            _slotId = slotId;
            _currentInstance = currentInstance;
            _pendingBuildBuildingId = null;

            if (root != null) root.SetActive(true);
            Refresh();
        }

        /// <summary>
        /// Call before Open() (or immediately after, for an empty slot) when
        /// the caller already knows which building belongs at this slot —
        /// see the KNOWN GAP note above.
        /// </summary>
        public void SetPendingBuildTarget(string buildingId)
        {
            _pendingBuildBuildingId = buildingId;
            Refresh();
        }

        public void Close()
        {
            _slotId = null;
            _currentInstance = null;
            _pendingBuildBuildingId = null;
            if (root != null) root.SetActive(false);
        }

        private void Refresh()
        {
            if (_currentInstance == null)
            {
                var target = _pendingBuildBuildingId ?? "(select a building)";
                if (titleLabel != null) titleLabel.text = target;
                if (statusLabel != null) statusLabel.text = "Not built";
                if (upgradeButton != null) upgradeButton.interactable = _pendingBuildBuildingId != null;
                return;
            }

            if (titleLabel != null) titleLabel.text = _currentInstance.buildingId;

            if (_currentInstance.upgradeFinishTick.HasValue)
            {
                if (statusLabel != null) statusLabel.text = $"Upgrading… (level {_currentInstance.level} -> {_currentInstance.level + 1})";
                if (upgradeButton != null) upgradeButton.interactable = false; // server already rejects with "already_upgrading" anyway
            }
            else
            {
                if (statusLabel != null) statusLabel.text = $"Level {_currentInstance.level}";
                if (upgradeButton != null) upgradeButton.interactable = true;
            }
        }

        private async void HandleUpgradeClicked()
        {
            var buildingId = _currentInstance?.buildingId ?? _pendingBuildBuildingId;
            if (string.IsNullOrEmpty(buildingId) || string.IsNullOrEmpty(_slotId))
            {
                Debug.LogWarning("BuildingDetailPanel: upgrade clicked with no building/slot resolved.");
                return;
            }

            if (upgradeButton != null) upgradeButton.interactable = false;

            var response = await Services.PlayerData.UpgradeBuildingAsync(buildingId, _slotId);

            if (!response.ok)
            {
                if (statusLabel != null) statusLabel.text = $"Failed: {response.error}";
                if (upgradeButton != null) upgradeButton.interactable = true;
                return;
            }

            // PlayerDataService already updated Kingdom + fired OnStateChanged,
            // which CityGridController listens to and will re-Render this
            // slot's BuildingSlotView. Refresh this panel's own instance
            // reference so it doesn't show stale data if left open.
            _currentInstance = response.building;
            Refresh();
        }
    }
}
