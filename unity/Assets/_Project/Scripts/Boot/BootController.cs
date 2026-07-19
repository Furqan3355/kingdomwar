// Assets/_Project/Scripts/Boot/BootController.cs
using System.Threading.Tasks;
using StormMmorts.Core;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace StormMmorts.Boot
{
    /// <summary>
    /// Entry point scene. Initializes services, attempts silent device-ID
    /// auth, and routes straight to City on success (§3.2) — no explicit
    /// "Login" screen is needed for the guest-first flow described in §6.1;
    /// the Login scene is reserved for account linking / email-password,
    /// not the default first-launch path.
    /// </summary>
    public class BootController : MonoBehaviour
    {
        private const string CitySceneName = "City";
        private const string LoginSceneName = "Login";

        private async void Start()
        {
            Services.Initialize();

            try
            {
                await Services.Nakama.AuthenticateDeviceAsync();
                await Services.Nakama.ConnectSocketAsync();
                await Services.PlayerData.LoadFullStateAsync();

                SceneManager.LoadScene(CitySceneName);
            }
            catch (System.Exception e)
            {
                Debug.LogError($"Boot sequence failed: {e}");
                // Fall back to an explicit login/retry screen rather than
                // leaving the player on a blank Boot scene.
                SceneManager.LoadScene(LoginSceneName);
            }
        }
    }
}
