cask "quotabar" do
  version "0.4.1"
  sha256 "c6107235676a7343f0adbcaac917a9717c05f3f8b77d92fbdf191dabe5681717"

  url "https://github.com/tluo-github/quotabar/releases/download/v#{version}/Quotabar-#{version}.zip"
  name "Quotabar"
  desc "Claude plan usage limits in the menu bar"
  homepage "https://github.com/tluo-github/quotabar"

  depends_on macos: ">= :sonoma"

  app "Quotabar.app"

  uninstall quit: "app.quotabar"

  zap trash: [
    "~/Library/Caches/app.quotabar",
    "~/Library/Preferences/app.quotabar.plist",
  ]
end
