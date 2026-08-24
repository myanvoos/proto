{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.proto;
in
{
  options.programs.proto = {
    enable = lib.mkEnableOption "PROTO coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.proto.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "PROTO package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
