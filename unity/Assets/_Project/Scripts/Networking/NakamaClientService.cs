// Assets/_Project/Scripts/Networking/NakamaClientService.cs
using System;
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

namespace StormMmorts.Networking
{
    /// <summary>
    /// Wraps the Nakama Unity SDK per Volume 1 §2 / §6. Both the Unity and
    /// Godot clients call the exact same server RPC names — this class is
    /// the Unity-side half of that contract, nothing more.
    /// </summary>
    public class NakamaClientService
    {
        private const string Scheme = "http"; // "https" in production
        private const string Host = "127.0.0.1";
        private const int Port = 7350;
        private const string ServerKey = "defaultkey";

        private const string SessionPrefsKey = "nakama_session_token";
        private const string RefreshPrefsKey = "nakama_refresh_token";

        public IClient Client { get; private set; }
        public ISession Session { get; private set; }
        public ISocket Socket { get; private set; }

        public NakamaClientService()
        {
            Client = new Client(Scheme, Host, Port, ServerKey);
        }

        /// <summary>
        /// Device-ID guest login (§6.1). Restores a saved session if still
        /// valid, otherwise authenticates fresh and persists the new tokens.
        /// </summary>
        public async Task<ISession> AuthenticateDeviceAsync()
        {
            var savedSessionToken = PlayerPrefs.GetString(SessionPrefsKey, null);
            var savedRefreshToken = PlayerPrefs.GetString(RefreshPrefsKey, null);

            if (!string.IsNullOrEmpty(savedSessionToken))
            {
                var restored = Nakama.Session.Restore(savedSessionToken, savedRefreshToken);
                if (!restored.IsExpired)
                {
                    Session = restored;
                    return Session;
                }

                if (!string.IsNullOrEmpty(savedRefreshToken))
                {
                    try
                    {
                        Session = await Client.SessionRefreshAsync(restored);
                        PersistSession(Session);
                        return Session;
                    }
                    catch (ApiResponseException)
                    {
                        // Refresh token also expired/invalid — fall through to fresh auth.
                    }
                }
            }

            var deviceId = GetOrCreateDeviceId();
            Session = await Client.AuthenticateDeviceAsync(deviceId);
            PersistSession(Session);
            return Session;
        }

        public async Task ConnectSocketAsync()
        {
            if (Session == null)
            {
                throw new InvalidOperationException("Must authenticate before connecting the socket.");
            }
            Socket = Client.NewSocket();
            await Socket.ConnectAsync(Session);
        }

        public async Task<string> RpcAsync(string id, string payload)
        {
            var result = await Client.RpcAsync(Session, id, payload);
            return result.Payload;
        }

        private void PersistSession(ISession session)
        {
            PlayerPrefs.SetString(SessionPrefsKey, session.AuthToken);
            PlayerPrefs.SetString(RefreshPrefsKey, session.RefreshToken);
            PlayerPrefs.Save();
        }

        private string GetOrCreateDeviceId()
        {
            const string key = "device_id";
            var id = PlayerPrefs.GetString(key, null);
            if (string.IsNullOrEmpty(id))
            {
                id = SystemInfo.deviceUniqueIdentifier;
                if (string.IsNullOrEmpty(id) || id == SystemInfo.unsupportedIdentifier)
                {
                    id = Guid.NewGuid().ToString();
                }
                PlayerPrefs.SetString(key, id);
                PlayerPrefs.Save();
            }
            return id;
        }
    }
}
