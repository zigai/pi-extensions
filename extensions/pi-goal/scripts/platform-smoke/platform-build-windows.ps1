param(
  [Parameter(Mandatory=$true)][string]$PackageName,
  [Parameter(Mandatory=$true)][int]$NodeValidationMajor
)

$ErrorActionPreference = "Continue"
& node .\scripts\platform-smoke\platform-build.mjs --package-name $PackageName --node-validation-major $NodeValidationMajor
exit $LASTEXITCODE
