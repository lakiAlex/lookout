cask "lookout" do
  version "1.3.0"
  sha256 "e2161bc82422cfafd820900c55548f728c024c3714fe6dac726f93e717b3c055"

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
