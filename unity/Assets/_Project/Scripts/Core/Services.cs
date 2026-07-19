// Assets/_Project/Scripts/Core/Services.cs
using UnityEngine;

namespace StormMmorts.Core
{
    /// <summary>
    /// Lightweight service locator per Volume 1 §3.1. Deliberately not a
    /// full DI framework (Zenject/VContainer) — do not introduce one without
    /// an explicit design decision, per implementation rule §8.
    /// </summary>
    public static class Services
    {
        public static Networking.NakamaClientService Nakama { get; private set; }
        public static Data.PlayerDataService PlayerData { get; private set; }

        private static bool _initialized;

        public static void Initialize()
        {
            if (_initialized)
            {
                Debug.LogWarning("Services.Initialize called more than once — ignoring.");
                return;
            }

            Nakama = new Networking.NakamaClientService();
            PlayerData = new Data.PlayerDataService(Nakama);
            _initialized = true;
        }
    }
}
