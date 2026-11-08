using System.Text.Json;
using Avalonia.Headless.XUnit;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>Making a new profile, from scratch or by capturing a repository.</summary>
public sealed class NewProfileTests : ViewModelTests
{
    [AvaloniaFact]
    public async Task A_new_profile_that_extends_another_opens_once_made()
    {
        var (profiles, cli, files) = await OpenOrgs();

        profiles.StartNew(null);

        Assert.True(profiles.ShowCreating);
        Assert.False(profiles.ShowProfile);
        Assert.Null(profiles.Selected);
        var form = profiles.Creating!;
        form.Name = "libraries";
        form.Extends = true;
        form.Base = form.Bases.Single(item => item.Name == "base");
        var made = Path.Combine(folders.Profiles, "libraries.yaml");
        cli.On(folders.List(), Listing(("base", files.Base, null), ("libraries", made, files.Base), ("orgs", files.Own, files.Base)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("extends: \"base.yaml\"\n", File.ReadAllText(made));
        Assert.False(profiles.ShowCreating);
        Assert.Equal("libraries", profiles.Selected?.Name);
        Assert.Equal(made, profiles.Current?.File);
        Assert.Null(profiles.Captured);
    }

    [AvaloniaFact]
    public async Task A_new_profile_never_takes_a_name_in_use()
    {
        var (profiles, _, _) = await OpenOrgs();
        profiles.StartNew(null);
        var form = profiles.Creating!;

        Assert.False(form.CreateCommand.CanExecute(null));
        Assert.Null(form.Problem);
        form.Name = "ORGS";
        Assert.Equal("orgs.yaml is already in this folder.", form.Problem);
        Assert.False(form.CreateCommand.CanExecute(null));
        folders.Write("old.yml", "");
        form.Name = "Old";
        Assert.Equal("old.yml is already in this folder.", form.Problem);
        foreach (var name in new[] { "team/libraries", ".hidden", "nul", "Com1.backup" })
        {
            form.Name = name;
            Assert.NotNull(form.Problem);
            Assert.False(form.CreateCommand.CanExecute(null));
        }
        form.Name = "libraries";
        Assert.True(form.CreateCommand.CanExecute(null));

        // A file made after the name was typed is not replaced.
        folders.Write("libraries.yaml", "merge: { allow_squash_merge: false }\n");
        await form.CreateCommand.ExecuteAsync(null);

        Assert.NotNull(form.Error);
        Assert.True(profiles.ShowCreating);
        Assert.Equal("merge: { allow_squash_merge: false }\n", File.ReadAllText(Path.Combine(folders.Profiles, "libraries.yaml")));
    }

    [AvaloniaFact]
    public void A_profile_extends_another_only_once_one_is_chosen()
    {
        var client = new RepottedClient(new FakeCli());
        using var form = new NewProfileViewModel(
            client, new ProfileFolder(client, folders.Settings), [], [], null, (_, _) => Task.CompletedTask, () => { }, () => { }, new HashSet<string>())
        {
            Name = "libraries",
            Extends = true,
        };

        Assert.False(form.CreateCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_capture_never_replaces_a_file_and_leaves_none_when_it_fails()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var cli = new FakeCli().OnCapture("TheLunchTrae/repotted", output =>
        {
            File.WriteAllText(output, "repository:\n");
            return NotFound;
        });
        var profiles = new ProfilesViewModel(new RepottedClient(cli.On(folders.List(), Documents.NoProfiles)), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
        await profiles.RefreshCommand.ExecuteAsync(null);
        // A capture the app never saw end, such as when it quit, leaves its file, which holds nothing.
        var left = folders.Write(".repotted.yaml.k2v9x0qa.4fz.repotted-capture", "repository:\n");
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;
        Assert.Null(form.Problem);

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("Not Found", form.Error);
        Assert.Equal([left], Directory.EnumerateFileSystemEntries(folders.Profiles));

        // A file made after the name was typed stops the capture before it reads GitHub.
        cli.Calls.Clear();
        folders.Write("repotted.yaml", "repository: { has_wiki: true }\n");
        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("repotted.yaml is already in this folder.", form.Error);
        Assert.Empty(cli.Calls);
        Assert.Equal("repository: { has_wiki: true }\n", File.ReadAllText(made));
    }

    [AvaloniaFact]
    public async Task Cancelling_a_capture_stops_it_and_keeps_what_the_user_opened_next()
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var finish = new TaskCompletionSource();
        var stopped = false;
        cli.OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
        {
            cancellationToken.Register(() => stopped = true);
            // A command line that finishes anyway, as one that is slow to stop would.
            await finish.Task;
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":["Skipped rulesets"]}""";
        });
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);

        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew(null);
        var next = profiles.Creating;
        finish.SetResult();
        await capturing;

        Assert.True(stopped);
        Assert.Equal([files.Base, files.Own], Directory.EnumerateFileSystemEntries(folders.Profiles).Order());
        Assert.Same(next, profiles.Creating);
        Assert.Null(profiles.Captured);
        Assert.Equal(files.Own, profiles.Current?.File);
    }

    [AvaloniaFact]
    public async Task A_capture_holds_its_name_and_frees_it_once_it_stops()
    {
        var (profiles, cli, _) = await OpenOrgs("TheLunchTrae/repotted");
        var finish = new TaskCompletionSource();
        cli.OnCapture("TheLunchTrae/repotted", async (output, _) =>
        {
            File.WriteAllText(output, "repository:\n");
            await finish.Task;
            return NotFound;
        });
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);

        // Another form cannot take the name while the closed one holds it, and can once it lets go.
        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew(null);
        var next = profiles.Creating!;
        next.Name = "Repotted";
        Assert.Equal("Another capture is making Repotted.yaml.", next.Problem);
        finish.SetResult();
        await capturing;

        Assert.Empty(Leftovers());
        Assert.Null(next.Problem);
    }

    [AvaloniaTheory]
    [InlineData("repotted.yaml")]
    [InlineData("Repotted.yaml")]
    public async Task A_file_that_arrives_during_a_capture_is_kept(string arrives)
    {
        var (profiles, cli, _) = await OpenOrgs("TheLunchTrae/repotted");
        cli.OnCapture("TheLunchTrae/repotted", output =>
        {
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            // A sync brings in a profile of the same name meanwhile.
            folders.Write(arrives, "repository: { has_issues: true }\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal($"{arrives} is already in this folder.", form.Error);
        Assert.Equal("repository: { has_issues: true }\n", File.ReadAllText(Path.Combine(folders.Profiles, arrives)));
        Assert.Empty(Leftovers());
    }

    [AvaloniaFact]
    public async Task A_capture_keeps_the_name_it_started_with()
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        cli.OnCapture("TheLunchTrae/repotted", async (output, _) =>
        {
            await finish.Task;
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;
        var capturing = form.CreateCommand.ExecuteAsync(null);

        Assert.False(form.Editable);
        // A name in use, typed while GitHub is read, changes nothing.
        form.Name = "orgs";
        finish.SetResult();
        await capturing;

        Assert.Null(form.Error);
        Assert.Equal("repository:\n  has_wiki: false\n", File.ReadAllText(made));
        Assert.Equal(made, profiles.Current?.File);
        Assert.True(form.Editable);
    }

    [AvaloniaFact]
    public async Task A_capture_is_not_held_against_its_own_form()
    {
        var (profiles, cli, _) = await OpenOrgs("TheLunchTrae/one", "TheLunchTrae/two");
        var finish = new Dictionary<string, TaskCompletionSource> { ["TheLunchTrae/one"] = new(), ["TheLunchTrae/two"] = new() };
        foreach (var (repository, done) in finish)
        {
            cli.OnCapture(repository, async (_, _) =>
            {
                await done.Task;
                return NotFound;
            });
        }
        profiles.StartNew("TheLunchTrae/one");
        var first = profiles.Creating!.CreateCommand.ExecuteAsync(null);
        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew("TheLunchTrae/two");
        var form = profiles.Creating!;
        var second = form.CreateCommand.ExecuteAsync(null);

        // The closed form's capture ends first, and the open form checks its name again.
        finish["TheLunchTrae/one"].SetResult();
        await first;

        Assert.Null(form.Problem);
        finish["TheLunchTrae/two"].SetResult();
        await second;
    }

    [AvaloniaFact]
    public async Task A_capture_whose_file_cannot_go_still_lets_go_of_its_name()
    {
        var cli = new FakeCli()
            .On(folders.List(), Documents.NoProfiles)
            .OnCapture("TheLunchTrae/repotted", output =>
            {
                File.WriteAllText(output, "repository:\n");
                // The folder goes while GitHub is read, so the file can't be removed.
                Directory.Delete(folders.Profiles, recursive: true);
                return NotFound;
            });
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("Not Found", form.Error);
        Assert.False(form.Working);
        profiles.StartNew(null);
        profiles.Creating!.Name = "repotted";
        Assert.Null(profiles.Creating.Problem);
    }

    [AvaloniaTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Changing_the_folder_during_a_capture_waits_on_the_question_and_leaves_no_capture_file(bool endsFirst)
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        cli.OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
        {
            File.WriteAllText(output, "repository:\n");
            await finish.Task.WaitAsync(cancellationToken);
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));
        Choose(profiles.Current!, "has_wiki", "On");
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        if (endsFirst)
        {
            // A capture that ends while the question waits makes its profile in the folder it started in.
            finish.SetResult();
            await capturing.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(profiles.HasLeaving);
        }
        profiles.DiscardAndLeaveCommand.Execute(null);
        await change.WaitAsync(TimeSpan.FromSeconds(5));
        // Otherwise leaving closes the form, which stops the capture.
        await capturing.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(other, profiles.Folder.Path);
        Assert.Equal(endsFirst, File.Exists(made));
        Assert.Empty(Leftovers());
    }

    [AvaloniaTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_question_that_cannot_settle_keeps_a_running_capture_and_says_why(bool save)
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var editor = profiles.Current!;
        var reload = Task.CompletedTask;
        var resolve = new TaskCompletionSource<string>();
        if (save)
        {
            Choose(editor, "has_wiki", "On");
            cli.On($"profile {files.Own} --set repository.has_wiki=true --json", """{"error":{"kind":"error","message":"The file could not be written"}}""", exitCode: 1);
        }
        else
        {
            // An editor reloading its file can't discard its changes yet.
            editor.Tab("Environments").Entries[0].Editor.Name = "pages";
            File.AppendAllText(files.Own, "# pulled by a sync\n");
            await editor.SaveCommand.ExecuteAsync(null);
            cli.On($"profile {files.Own} --json", _ => resolve.Task);
            reload = editor.ReloadCommand.ExecuteAsync(null);
        }
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        var stopped = false;
        cli.OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
        {
            cancellationToken.Register(() => stopped = true);
            await finish.Task.WaitAsync(cancellationToken);
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;
        var capturing = form.CreateCommand.ExecuteAsync(null);
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);
        // A notice already showing, which the one about the question covers for a while.
        const string Earlier = "Repotted could not remember this folder for next time: the disk is full";
        profiles.Notice = Earlier;
        var notice = save
            ? "orgs could not be saved, so you cannot change the folder yet."
            : "orgs is still loading, so you cannot change the folder yet.";
        async Task Answer()
        {
            var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
            Assert.True(profiles.HasLeaving);
            if (save)
            {
                await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
            }
            else
            {
                profiles.DiscardAndLeaveCommand.Execute(null);
            }
            await change.WaitAsync(TimeSpan.FromSeconds(5));
        }

        await Answer();

        // Opening the profile would close the form and stop the capture, so the notice says why instead.
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        Assert.Same(form, profiles.Creating);
        Assert.True(form.Working);
        Assert.False(stopped);
        Assert.Equal(notice, profiles.Notice);

        // Asking again takes it away, and the notice it covered shows again.
        var asking = profiles.ChangeFolderCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        Assert.Equal(Earlier, profiles.Notice);
        profiles.StayHereCommand.Execute(null);
        await asking.WaitAsync(TimeSpan.FromSeconds(5));
        await Answer();
        Assert.Equal(notice, profiles.Notice);
        resolve.SetResult(Documents.Resolved(files.Own, files.Base));
        await reload.WaitAsync(TimeSpan.FromSeconds(5));
        finish.SetResult();
        await capturing.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(File.Exists(made));
        Assert.NotNull(profiles.Notice);

        // The notice goes once the profile it names opens.
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        Assert.Equal(Earlier, profiles.Notice);
    }

    [AvaloniaFact]
    public async Task Captures_in_two_copies_of_the_app_write_files_of_their_own()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var outputs = new List<string>();
        var finish = new[] { new TaskCompletionSource(), new TaskCompletionSource() };
        var cli = new FakeCli()
            .On(folders.List(), Documents.NoProfiles)
            .OnCapture("TheLunchTrae/repotted", async (output, _) =>
            {
                var index = outputs.Count;
                outputs.Add(output);
                File.WriteAllText(output, $"# copy {index}\n");
                await finish[index].Task;
                return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
            });
        var forms = new List<NewProfileViewModel>();
        foreach (var _ in finish)
        {
            var copy = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
            await copy.RefreshCommand.ExecuteAsync(null);
            copy.StartNew("TheLunchTrae/repotted");
            forms.Add(copy.Creating!);
        }
        var capturing = forms.Select(form => form.CreateCommand.ExecuteAsync(null)).ToList();

        Assert.Equal(2, outputs.Distinct().Count());
        finish[0].SetResult();
        await capturing[0];
        finish[1].SetResult();
        await capturing[1];

        Assert.Equal("# copy 0\n", File.ReadAllText(made));
        Assert.Equal("repotted.yaml is already in this folder.", forms[1].Error);
        Assert.Empty(Leftovers());
    }

    [AvaloniaFact]
    public async Task A_refresh_keeps_the_form_and_a_new_folder_closes_it()
    {
        var (profiles, cli, files) = await OpenOrgs();
        profiles.StartNew(null);
        var form = profiles.Creating!;
        form.Name = "libraries";

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Same(form, profiles.Creating);
        Assert.Null(profiles.Selected);
        profiles.CancelNew();
        Assert.Equal(files.Own, profiles.Current?.File);

        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        var desktop = new FakeDesktop { Folder = other };
        var moving = new ProfilesViewModel(new RepottedClient(cli.On(folders.List(other), Documents.NoProfiles)), desktop, folders.Settings, () => []);
        await moving.RefreshCommand.ExecuteAsync(null);
        moving.StartNew(null);

        await moving.ChangeFolderCommand.ExecuteAsync(null);

        Assert.Null(moving.Creating);
        Assert.True(moving.ShowEmpty);
    }

    [AvaloniaFact]
    public async Task Leaving_a_new_profile_goes_back_to_the_open_one()
    {
        var (profiles, _, files) = await OpenOrgs();

        profiles.StartNew(null);
        profiles.Creating!.CancelCommand.Execute(null);

        Assert.True(profiles.ShowProfile);
        Assert.Equal("orgs", profiles.Selected?.Name);

        profiles.StartNew(null);
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");

        Assert.False(profiles.ShowCreating);
        Assert.Equal(files.Base, profiles.Current?.File);
    }

    [AvaloniaFact]
    public async Task Capturing_a_repository_makes_a_profile_and_says_what_it_left_out()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.NoProfiles)
            .OnCapture("TheLunchTrae/repotted", output =>
            {
                File.WriteAllText(output, "repository:\n  has_wiki: false\n");
                return """{"repository":"TheLunchTrae/repotted","profile":{"repository":{"has_wiki":false}},"warnings":["Skipped rulesets: this repository’s plan does not support rulesets","Skipped environments: the app cannot read Actions"]}""";
            });
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => Task.CompletedTask);
        await shell.RefreshAsync();
        shell.Repositories.Selected = shell.Repositories.Rows.Single(row => row.Name == "repotted");

        shell.Repositories.CaptureCommand.Execute(null);

        Assert.True(shell.ShowingProfiles);
        Assert.Equal($"Profiles / {ControlLabel.For("New profile")}", shell.Crumb);
        var form = shell.Profiles.Creating!;
        Assert.True(form.Captures);
        Assert.Equal(("repotted", "TheLunchTrae/repotted"), (form.Name, form.Repository));
        Assert.Equal(["TheLunchTrae/github-setup", "TheLunchTrae/repotted", "TheLunchTrae/test-repo"], form.Repositories);
        var other = folders.Write("other.yaml", "");
        cli.On(folders.List(), Listing(("other", other, null), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made))
            .On($"profile {other} --json", Documents.ResolvedBase(other));

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("repository:\n  has_wiki: false\n", File.ReadAllText(made));
        Assert.Empty(Leftovers());
        Assert.Equal("Profiles / repotted", shell.Crumb);
        Assert.Equal(
            "Repotted could not read all of the repository, so this profile leaves out:\nSkipped rulesets: this repository’s plan does not support rulesets\nSkipped environments: the app cannot read Actions",
            shell.Profiles.Captured);

        // The note is about the captured profile, so it goes once another opens.
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "other");
        Assert.Null(shell.Profiles.Captured);

        // A finished capture holds its name no longer, so it is free once the profile is gone.
        File.Delete(made);
        shell.Profiles.StartNew(null);
        shell.Profiles.Creating!.Name = "repotted";
        Assert.Null(shell.Profiles.Creating.Problem);
    }

    private const string NotFound = """{"error":{"kind":"error","message":"Not Found"}}""";

    private static string Listing(params (string Name, string File, string? Extends)[] profiles) =>
        JsonSerializer.Serialize(new { profiles = profiles.Select(profile => new { name = profile.Name, file = profile.File, extends = profile.Extends, problem = (string?)null }) });
}
