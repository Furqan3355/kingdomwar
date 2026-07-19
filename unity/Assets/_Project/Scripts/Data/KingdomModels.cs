// Assets/_Project/Scripts/Data/KingdomModels.cs
using System;
using System.Collections.Generic;

namespace StormMmorts.Data
{
    // Mirrors modules/types.ts exactly. Do not add fields here that aren't
    // also added server-side first — this is a client-side reflection of the
    // server's authoritative shape, not an independent model (§7, rule §9).
    //
    // IMPORTANT: Unity's built-in JsonUtility cannot deserialize
    // Dictionary<TKey,TValue> fields (buildings, army, researchLevels below).
    // PlayerDataService.cs uses Newtonsoft.Json (com.unity.nuget.newtonsoft-json)
    // for all deserialization of these models — do not switch call sites to
    // JsonUtility.FromJson for anything containing a Dictionary field.

    [Serializable]
    public class ResourceBundle
    {
        public double gold;
        public double crystal;
        public double mithril;
    }

    [Serializable]
    public class BuildingInstance
    {
        public string buildingId;
        public string slot;
        public int level;
        public long? upgradeFinishTick; // unix seconds, null if not upgrading
    }

    [Serializable]
    public class KingdomState
    {
        public string userId;
        public int shardId;
        public int castleLevel;
        public Dictionary<string, BuildingInstance> buildings = new Dictionary<string, BuildingInstance>();
        public ResourceBundle resources;
        public long lastCalculatedTick;
        public Dictionary<string, int> army = new Dictionary<string, int>();
        public Dictionary<string, int> researchLevels = new Dictionary<string, int>();
        public string allianceId;
        public string displayName;
        public double power;
    }

    [Serializable]
    public class AllianceSummaryStub
    {
        public string id;
        public bool stub;
    }

    [Serializable]
    public class FullStateResponse
    {
        public bool ok;
        public string error;
        public KingdomState kingdom;
        public object[] army;   // Volume 5 fills this in
        public object[] heroes; // Volume 4 fills this in
        public AllianceSummaryStub alliance; // null until Volume 7
    }

    [Serializable]
    public class UpgradeBuildingResponse
    {
        public bool ok;
        public string error;
        public BuildingInstance building;
        public ResourceBundle resources;
    }
}
