# Homebrew formula, served from this repository as a tap:
#   brew tap Joe-Simo/a0 https://github.com/Joe-Simo/a0 && brew install a0
# The release workflow sets the version in the four URLs and the four sha256 values (tools/homebrew-formula.sh,
# from the release's checksums.txt); everything else is edited here.
class A0 < Formula
  desc "Programming language built for AI, not for people"
  homepage "https://github.com/Joe-Simo/a0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Joe-Simo/a0/releases/download/v0.8.16/a0-darwin-arm64"
      sha256 "b847338c79c09b1c61503c8177243929c7835bd9ddc1ef1e02d4f22ab035b7c8"
    end
    on_intel do
      url "https://github.com/Joe-Simo/a0/releases/download/v0.8.16/a0-darwin-x64"
      sha256 "c0d7253395d816e65f1f36d24ef61ea88c84c9c33f37e647d1998ca442035ddf"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Joe-Simo/a0/releases/download/v0.8.16/a0-linux-arm64"
      sha256 "c9975c6e30a155229d7ab2ffb8b07a14fe22729fa112831f00fd65a80fac7baf"
    end
    on_intel do
      url "https://github.com/Joe-Simo/a0/releases/download/v0.8.16/a0-linux-x64"
      sha256 "bb8a3fc2edee971a2af2983a674c74b94766b6d9c5a483c53e8f20cf2d026233"
    end
  end

  def install
    bin.install Dir["a0-*"].first => "a0"
  end

  test do
    (testpath/"sq.a0").write "fn sq u32 -> u32\na mul p0 p0\nret a\nend\n"
    system bin/"a0", "check", testpath/"sq.a0"
    assert_match version.to_s, shell_output("#{bin}/a0 --version")
    assert_equal "144", shell_output("#{bin}/a0 run #{testpath}/sq.a0 sq 12").strip
  end
end
