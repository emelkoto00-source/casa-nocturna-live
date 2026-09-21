-- ModuleScript example consumer. Adapt this small section into your existing MusicClient / PlaylistModule.
-- Each song's `speed` is already the inverse of the website conversion multiplier.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local runtime = ReplicatedStorage:WaitForChild("CasaMusicRuntime")
local value = runtime:WaitForChild("LibraryJson")

local function readLibrary()
    if value.Value == "" then return {} end
    local ok, data = pcall(HttpService.JSONDecode, HttpService, value.Value)
    if not ok or type(data) ~= "table" then return {} end
    return data.songs or {}
end

local function playEntry(sound, song, assetId)
    sound.SoundId = "rbxassetid://" .. tostring(assetId)
    sound.PlaybackSpeed = tonumber(song.speed) or 1
    sound:Play()
end

-- Your existing UI/player can call readLibrary(), then playEntry(...).
return {
    ReadLibrary = readLibrary,
    PlayEntry = playEntry,
}
