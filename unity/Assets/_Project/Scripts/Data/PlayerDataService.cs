// Assets/_Project/Scripts/Data/PlayerDataService.cs
using System;
using System.Threading.Tasks;
using Newtonsoft.Json;
using StormMmorts.Networking;
using UnityEngine;

namespace StormMmorts.Data
{
    /// <summary>
    /// Owns the client's copy of KingdomState, kept in sync with the server
    /// via RPC calls only — this class never mutates state locally except as
    /// optimistic UI feedback that gets reconciled on the next server
    /// response (§2.4). It never "saves"; every write already round-trips
    /// through the server (§8.1).
    /// </summary>
    public class PlayerDataService
    {
        private readonly NakamaClientService _nakama;

        public KingdomState Kingdom { get; private set; }
        public event Action OnStateChanged;

        public PlayerDataService(NakamaClientService nakama)
        {
            _nakama = nakama;
        }

        /// <summary>
        /// Single aggregated call on session start per §8.2 — do not add
        /// separate per-system fetch calls here; extend get_full_state
        /// server-side instead when a new system needs to appear at login.
        /// </summary>
        public async Task<FullStateResponse> LoadFullStateAsync()
        {
            var raw = await _nakama.RpcAsync("get_full_state", "{}");
            var response = JsonConvert.DeserializeObject<FullStateResponse>(raw);

            if (!response.ok)
            {
                Debug.LogError($"get_full_state failed: {response.error}");
                return response;
            }

            Kingdom = response.kingdom;
            OnStateChanged?.Invoke();
            return response;
        }

        /// <summary>
        /// Requests a building upgrade. Applies an optimistic local timer
        /// immediately for latency hiding, then reconciles against the
        /// authoritative server response (§2.4) — rolls back on failure.
        /// </summary>
        public async Task<UpgradeBuildingResponse> UpgradeBuildingAsync(string buildingId, string slot)
        {
            var key = $"{buildingId}:{slot}";
            BuildingInstance previous = null;
            Kingdom.buildings.TryGetValue(key, out previous);

            // Optimistic placeholder — UI can show "upgrading..." immediately.
            // Real finish tick comes from the server response below.
            var optimisticFinish = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
            Kingdom.buildings[key] = new BuildingInstance
            {
                buildingId = buildingId,
                slot = slot,
                level = previous?.level ?? 0,
                upgradeFinishTick = optimisticFinish,
            };
            OnStateChanged?.Invoke();

            var payload = JsonConvert.SerializeObject(new { buildingId, slot });
            var raw = await _nakama.RpcAsync("upgrade_building", payload);
            var response = JsonConvert.DeserializeObject<UpgradeBuildingResponse>(raw);

            if (!response.ok)
            {
                // Roll back the optimistic update — this is why prediction is
                // limited to timer display only, never resource totals (§2.4).
                if (previous != null) Kingdom.buildings[key] = previous;
                else Kingdom.buildings.Remove(key);
                Debug.LogWarning($"upgrade_building failed: {response.error}");
            }
            else
            {
                Kingdom.buildings[key] = response.building;
                Kingdom.resources = response.resources;
            }

            OnStateChanged?.Invoke();
            return response;
        }
    }
}
