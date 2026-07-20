// Assets/_Project/Scripts/City/BuildingSlotView.cs
using System;
using StormMmorts.Data;
using UnityEngine;
using UnityEngine.UI;

namespace StormMmorts.City
{
    /// <summary>
    /// Renders one of three states per grid slot (Volume 2 §1.3): empty (tap
    /// to open the build menu), built (sprite/model at current level), or
    /// upgrading (in-progress visual + countdown). The countdown is driven
    /// entirely by the server's upgradeFinishTick, never a locally-owned
    /// timer that could drift from the authoritative value (§1.3, §2.4).
    /// </summary>
    public class BuildingSlotView : MonoBehaviour
    {
        [SerializeField] private string slotId;
        public string SlotId => slotId;

        [Header("Visual states — assign in inspector")]
        [SerializeField] private GameObject emptyStateRoot;
        [SerializeField] private GameObject builtStateRoot;
        [SerializeField] private GameObject upgradingStateRoot;

        [Header("Built state")]
        [SerializeField] private Text buildingLabel; // swap for TMP_Text if the project uses TextMeshPro

        [Header("Upgrading state")]
        [SerializeField] private Text countdownLabel;

        [SerializeField] private Button tapButton;

        private BuildingInstance _current;
        private Action<BuildingSlotView, BuildingInstance> _onTapped;

        public void Initialize(Action<BuildingSlotView, BuildingInstance> onTapped)
        {
            _onTapped = onTapped;
            if (tapButton != null)
            {
                tapButton.onClick.RemoveListener(HandleTap);
                tapButton.onClick.AddListener(HandleTap);
            }
        }

        private void HandleTap()
        {
            _onTapped?.Invoke(this, _current);
        }

        /// <summary>
        /// instance == null -> empty slot. instance.upgradeFinishTick.HasValue
        /// -> upgrading. Otherwise -> built at instance.level.
        /// </summary>
        public void Render(BuildingInstance instance)
        {
            _current = instance;

            if (instance == null)
            {
                ShowEmpty();
                return;
            }
            if (instance.upgradeFinishTick.HasValue)
            {
                ShowUpgrading(instance.upgradeFinishTick.Value);
                return;
            }
            ShowBuilt(instance.buildingId, instance.level);
        }

        private void ShowEmpty()
        {
            SetActiveStates(empty: true, built: false, upgrading: false);
        }

        private void ShowBuilt(string buildingId, int level)
        {
            SetActiveStates(empty: false, built: true, upgrading: false);
            if (buildingLabel != null) buildingLabel.text = $"{buildingId} Lv.{level}";
        }

        private void ShowUpgrading(long upgradeFinishTick)
        {
            SetActiveStates(empty: false, built: false, upgrading: true);
            UpdateCountdown(upgradeFinishTick);
        }

        private void Update()
        {
            // Only the upgrading state needs a per-frame countdown; the finish
            // tick itself never changes locally between server responses.
            if (_current != null && _current.upgradeFinishTick.HasValue && upgradingStateRoot != null && upgradingStateRoot.activeSelf)
            {
                UpdateCountdown(_current.upgradeFinishTick.Value);
            }
        }

        private void UpdateCountdown(long upgradeFinishTick)
        {
            if (countdownLabel == null) return;
            var remaining = upgradeFinishTick - DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            countdownLabel.text = remaining > 0
                ? TimeSpan.FromSeconds(remaining).ToString(@"mm\:ss")
                : "00:00";
        }

        private void SetActiveStates(bool empty, bool built, bool upgrading)
        {
            if (emptyStateRoot != null) emptyStateRoot.SetActive(empty);
            if (builtStateRoot != null) builtStateRoot.SetActive(built);
            if (upgradingStateRoot != null) upgradingStateRoot.SetActive(upgrading);
        }
    }
}
