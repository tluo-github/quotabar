cask "quotabar" do
  version "0.4.0"
  sha256 "c1faa6c7b26e6f99e8ddb98bab38f81abe2201d5cb7b3524636a589eede1786b"

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
