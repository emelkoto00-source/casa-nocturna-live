-- ServerScriptService/RobloxSync.server.lua
-- Enable Game Settings > Security > Allow HTTP Requests.
-- Keep this Script server-side. Do not place the token in a LocalScript.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local BASE_URL = "https://YOUR-DOMAIN.example"
local GAME_SYNC_TOKEN = "PASTE_GAME_SYNC_TOKEN_HERE"
local REFRESH_SECONDS = 20

local folder = ReplicatedStorage:FindFirstChild("CasaMusicRuntime") or Instance.new("Folder")
folder.Name = "CasaMusicRuntime"
folder.Parent = ReplicatedStorage

local jsonValue = folder:FindFirstChild("LibraryJson") or Instance.new("StringValue")
jsonValue.Name = "LibraryJson"
jsonValue.Parent = folder

local function refresh()
    local ok, response = pcall(function()
        return HttpService:RequestAsync({
            Url = BASE_URL .. "/api/game/library",
            Method = "GET",
            Headers = {
                ["Authorization"] = "Bearer " .. GAME_SYNC_TOKEN,
            },
        })
    end)
    if not ok then
        warn("Casa music sync request failed:", response)
        return
    end
    if not response.Success then
        warn("Casa music sync HTTP", response.StatusCode, response.Body)
        return
    end
    jsonValue.Value = response.Body
end

refresh()
while task.wait(REFRESH_SECONDS) do
    refresh()
end
