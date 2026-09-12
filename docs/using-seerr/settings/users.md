---
title: User Settings
description: Configure global and default user settings.
sidebar_position: 2
---

# Users

## Enable Local Sign-In

When enabled, users who have configured passwords will be allowed to sign in using their email address.

When disabled, your mediaserver OAuth becomes the only sign-in option, and any "local users" you have created will not be able to sign in to Seerr.

This setting is **enabled** by default.

## Enable Jellyfin/Emby/Plex Sign-In

When enabled, users will be able to sign in to Seerr using their Jellyfin/Emby/Plex credentials, provided they have linked their media server accounts.

When disabled, users will only be able to sign in using their email address. Users without a password set will not be able to sign in to Seerr.

This setting is **enabled** by default.

## Enable Jellyfin/Emby Sign-In (Additional Servers)

Seerr can also let users sign in with a Jellyfin or Emby server other than your primary media server. For example, if Plex is your primary media server but some of your users use a Jellyfin server, enable **Jellyfin Sign-In** here and enter the connection details of that Jellyfin server. Users can then pick the server they want to sign in with on the sign-in page.

Additional servers are only used for authentication: libraries and availability are still synced from your primary media server, and users cannot be imported from additional servers.

The following settings are available for each additional server:

- **Hostname or IP Address** and **Port**: how Seerr reaches the server. Seerr checks that the server is reachable when you save.
- **Use SSL** and **URL Base**: enable these if the server is served over HTTPS or under a sub-path.
- **External URL**: the address your users use to reach the server. It is used for the **Forgot Password?** link on the sign-in page.
- **Forgot Password URL**: a custom page to send users to when they click **Forgot Password?**.

These settings are **disabled** by default.

## Enable New Jellyfin/Emby/Plex Sign-In

When enabled, users with access to your media server (or to an [additional sign-in server](#enable-jellyfinemby-sign-in-additional-servers)) will be able to sign in to Seerr even if they have not yet been imported. Users will be automatically assigned the permissions configured in the [Default Permissions](#default-permissions) setting upon first sign-in.

This setting is **enabled** by default.

## Global Movie Request Limit & Global Series Request Limit

Select the request limits you would like granted to users.

Unless an override is configured, users are granted these global request limits.

Note that users with the **Manage Users** permission are exempt from request limits, since that permission also grants the ability to submit requests on behalf of other users.

## Default Permissions

Select the permissions you would like assigned to new users to have by default upon account creation.

If [Enable New Jellyfin/Emby/Plex Sign-In](#enable-new-jellyfinembyplex-sign-in) is enabled, any user with access to your media server will be able to sign in to Seerr, and they will be granted the permissions you select here upon first sign-in.

This setting only affects new users, and has no impact on existing users. In order to modify permissions for existing users, you will need to edit the users.
