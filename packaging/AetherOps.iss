#define MyAppName "AetherOps"
#define MyAppVersion "0.1.0-alpha.1"
#define MyAppExeName "aetherops.exe"

[Setup]
AppId={{FF24D8DD-9A62-4A19-99D5-D9B8AE707228}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\AetherOps
DefaultGroupName=AetherOps
OutputDir=..\dist
OutputBaseFilename=AetherOps-{#MyAppVersion}-windows-x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\icons\aetherops.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Tasks]
Name: "autostart"; Description: "Windows 로그인 시 AetherOps 시작"; GroupDescription: "추가 작업:"; Flags: unchecked

[Files]
Source: "..\build\portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\AetherOps"; Filename: "{app}\{#MyAppExeName}"
Name: "{userstartup}\AetherOps"; Filename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "AetherOps 시작"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{localappdata}\AetherOps\v2\runtimes"; Check: IsManagedRuntimeUninstallTargetSafe
Type: filesandordirs; Name: "{localappdata}\AetherOps\v2\webview2"; Check: ShouldDeleteBrowserProfiles
Type: filesandordirs; Name: "{localappdata}\AetherOps\v2"; Check: ShouldDeleteAllUserData

; Only app-managed runtime versions and candidates are removed from the data
; root by default. Interactive uninstall offers explicit, default-No choices
; for browser profiles or all v2 data. Silent uninstall preserves both unless
; /DELETEBROWSERPROFILES or /DELETEUSERDATA is explicitly supplied.

[Code]
var
  DeleteBrowserProfilesRequested: Boolean;
  DeleteAllUserDataRequested: Boolean;

function IsProductDataUninstallTargetSafe: Boolean;
var
  LocalDataRoot: String;
  ProductDataRoot: String;
begin
  LocalDataRoot := RemoveBackslashUnlessRoot(ExpandConstant('{localappdata}'));
  ProductDataRoot := RemoveBackslashUnlessRoot(
    ExpandConstant('{localappdata}\AetherOps\v2'));

  Result :=
    (LocalDataRoot <> '') and
    (ProductDataRoot <> '') and
    (CompareText(ProductDataRoot,
      AddBackslash(LocalDataRoot) + 'AetherOps\v2') = 0) and
    (CompareText(ProductDataRoot, LocalDataRoot) <> 0);
end;

function IsManagedRuntimeUninstallTargetSafe: Boolean;
var
  ProductDataRoot: String;
  ManagedRuntimeRoot: String;
begin
  ProductDataRoot := RemoveBackslashUnlessRoot(
    ExpandConstant('{localappdata}\AetherOps\v2'));
  ManagedRuntimeRoot := RemoveBackslashUnlessRoot(
    ExpandConstant('{localappdata}\AetherOps\v2\runtimes'));

  Result :=
    IsProductDataUninstallTargetSafe and
    (CompareText(ManagedRuntimeRoot,
      AddBackslash(ProductDataRoot) + 'runtimes') = 0) and
    (CompareText(ManagedRuntimeRoot, ProductDataRoot) <> 0);
end;

function IsBrowserProfileUninstallTargetSafe: Boolean;
var
  ProductDataRoot: String;
  BrowserProfileRoot: String;
begin
  ProductDataRoot := RemoveBackslashUnlessRoot(
    ExpandConstant('{localappdata}\AetherOps\v2'));
  BrowserProfileRoot := RemoveBackslashUnlessRoot(
    ExpandConstant('{localappdata}\AetherOps\v2\webview2'));

  Result :=
    IsProductDataUninstallTargetSafe and
    (CompareText(BrowserProfileRoot,
      AddBackslash(ProductDataRoot) + 'webview2') = 0) and
    (CompareText(BrowserProfileRoot, ProductDataRoot) <> 0);
end;

function ShouldDeleteBrowserProfiles: Boolean;
begin
  Result := DeleteBrowserProfilesRequested and
    IsBrowserProfileUninstallTargetSafe;
end;

function ShouldDeleteAllUserData: Boolean;
begin
  Result := DeleteAllUserDataRequested and
    IsProductDataUninstallTargetSafe;
end;

function HasExactUninstallSwitch(const SwitchName: String): Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
  begin
    if CompareText(ParamStr(Index), SwitchName) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function InitializeUninstall: Boolean;
begin
  DeleteAllUserDataRequested :=
    HasExactUninstallSwitch('/DELETEUSERDATA');
  DeleteBrowserProfilesRequested :=
    DeleteAllUserDataRequested or
    HasExactUninstallSwitch('/DELETEBROWSERPROFILES');
  Result := True;
end;

procedure InitializeUninstallProgressForm;
begin
  if UninstallSilent or DeleteAllUserDataRequested or
    DeleteBrowserProfilesRequested then
    Exit;

  if MsgBox(
    'AetherOps 사용자 데이터를 모두 삭제하시겠습니까?' #13#10#13#10 +
    'SQLite 데이터베이스, CAS 자료, Codex 전용 설정, 다운로드, 관리 런타임, ' +
    '셸 및 인터넷 브라우저 프로필이 영구 삭제됩니다.' #13#10#13#10 +
    '기본 선택은 아니요이며 프로그램만 제거해도 데이터는 보존됩니다.',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
  begin
    if MsgBox(
      '최종 확인: %LOCALAPPDATA%\AetherOps\v2 아래의 모든 사용자 데이터를 ' +
      '복구할 수 없게 삭제합니다. 계속하시겠습니까?',
      mbError, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DeleteAllUserDataRequested := True;
      DeleteBrowserProfilesRequested := True;
    end;
    Exit;
  end;

  DeleteBrowserProfilesRequested :=
    MsgBox(
      '브라우저 프로필만 초기화하시겠습니까?' #13#10#13#10 +
      '셸 및 인터넷 WebView2 로그인 세션과 사이트 데이터만 삭제합니다. ' +
      'SQLite 데이터베이스, CAS 자료, Codex 설정과 다운로드는 보존됩니다.' #13#10#13#10 +
      '기본 선택은 아니요입니다.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;
