cask "lookout" do
  version "1.2.0"
  sha256 "a6605370dcc0c7a45ace9fdbf0dd91371330176f1f0ec07f6b731cf88c528dc2"

  url "https://github.com/lakiAlex/lookout/releases/download/v#{version}/Lookout_#{version}_universal.dmg"
  name "Lookout"
  desc "Terminal for Claude Code, with files, search, git and an element picker"
  homepage "https://github.com/lakiAlex/lookout"

  depends_on macos: ">= :big_sur"

  app "Lookout.app"

  zap trash: [
    "~/Library/Application Support/com.laki.lookout",
    "~/Library/Caches/com.laki.lookout",
    "~/Library/Preferences/com.laki.lookout.plist",
    "~/Library/Saved Application State/com.laki.lookout.savedState",
  ]
end
