# Homebrew formula, served from this repository as a tap:
#   brew tap Joe-Simo/a0 https://github.com/Joe-Simo/a0 && brew install a0
# The release workflow sets `version` and the four sha256 values (tools/homebrew-formula.sh,
# from the release's checksums.txt); everything else is edited here.
class A0 < Formula
  desc "Programming language built for AI, not for people"
  homepage "https://github.com/Joe-Simo/a0"
  version "0.8.15"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Joe-Simo/a0/releases/download/v#{version}/a0-darwin-arm64"
      sha256 "77644b9a5daea0b6b0245eeb97aa03af2a478d4814f58bb652aaff2bfe41cea6"
    end
    on_intel do
      url "https://github.com/Joe-Simo/a0/releases/download/v#{version}/a0-darwin-x64"
      sha256 "da8971538981e84885d00b6fa5db87fad00dca395540e936f46a04a4858a6b7d"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Joe-Simo/a0/releases/download/v#{version}/a0-linux-arm64"
      sha256 "9677d02a08eec9d7b1c1894a944829c780a68e7d58172ad01001db9095aeef5c"
    end
    on_intel do
      url "https://github.com/Joe-Simo/a0/releases/download/v#{version}/a0-linux-x64"
      sha256 "50f457b152fe009124e2bdd014000002efe08706fc219df61b57ababb464a718"
    end
  end

  def install
    bin.install Dir["a0-*"].first => "a0"
  end

  test do
    (testpath/"sq.a0").write "fn sq u32 -> u32\na mul p0 p0\nret a\nend\n"
    system bin/"a0", "check", testpath/"sq.a0"
    assert_equal "144", shell_output("#{bin}/a0 run #{testpath}/sq.a0 sq 12").strip
  end
end
